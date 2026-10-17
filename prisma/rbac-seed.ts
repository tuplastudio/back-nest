import type { PrismaClient } from '../src/generated/control-plane/client';
import type { PrismaClient as TenantPlaneClient } from '../src/generated/tenant-plane/client';
import { PERMISSION_CATALOG } from '../src/auth/permission-catalog';

/**
 * System roles the base ships with.
 *
 * Permissions are the authority; roles are the vocabulary an administrator
 * assigns to people. The built-in roles exist so a fresh deployment has a
 * working starting point without anyone hand-assembling permissions.
 *
 * `*` is not accepted here: a role's grants are always explicit, so revoking a
 * permission is a deletion rather than an exclusion-list edit.
 */
export const SYSTEM_ROLES: readonly {
  readonly name: string;
  readonly description: string;
  /** Modules whose permissions this role receives wholesale. */
  readonly modules: readonly string[];
  /** Additional individual permissions, beyond the modules. */
  readonly permissions: readonly string[];
}[] = [
  {
    name: 'platform-owner',
    description: 'Unrestricted platform authority, including tenant purge.',
    modules: ['tenants', 'api-keys', 'users', 'projects', 'audit', 'payments', 'webhooks'],
    permissions: [],
  },
  {
    name: 'platform-admin',
    description: 'Day-to-day platform operations; cannot purge a tenant.',
    modules: ['tenants', 'api-keys', 'users', 'projects', 'audit', 'payments', 'webhooks'],
    permissions: [],
  },
  {
    name: 'platform-auditor',
    description: 'Read-only platform access.',
    modules: [],
    permissions: [
      'tenants:read',
      'api-keys:read',
      'users:read',
      'projects:read',
      'audit:read',
      'payments:read',
      'webhooks:read',
    ],
  },
  {
    name: 'tenant-owner',
    description: 'Full authority inside one tenant, including its payment configuration.',
    modules: ['api-keys', 'users', 'projects', 'payments', 'webhooks'],
    permissions: [],
  },
  {
    name: 'tenant-admin',
    // `webhooks` is deliberately absent. Registering an outbound destination
    // opens a channel through which tenant data leaves the platform, on top of
    // the outbound-request surface the URL guard has to police, so that decision
    // belongs to whoever controls the tenant rather than to an operator.
    description: 'Manages members, credentials and payments inside one tenant.',
    modules: ['api-keys', 'users', 'projects', 'payments'],
    permissions: [],
  },
  {
    name: 'tenant-member',
    description: 'Creates and edits resources inside one tenant.',
    modules: [],
    permissions: ['projects:read', 'projects:write'],
  },
  {
    name: 'tenant-viewer',
    description: 'Read-only access inside one tenant.',
    modules: [],
    permissions: ['projects:read', 'users:read'],
  },
];

/**
 * Seeds the RBAC catalogue: modules, then permissions grouped under them, then
 * the system roles with their permission grants.
 *
 * Idempotent — every write is an upsert keyed on the natural name, so running the
 * seed again reconciles rather than duplicates. Existing role grants are left
 * alone: a permission removed from a system role is *not* revoked here, because
 * that would silently shrink an operator's authority on an unrelated re-run.
 * Revocation is an explicit administrative act.
 *
 * @param prisma Control-plane client.
 * @returns The seeded role ids, keyed by role name.
 */
export async function seedRbacCatalog(prisma: PrismaClient): Promise<Record<string, string>> {
  const moduleIds = new Map<string, string>();
  for (const definition of PERMISSION_CATALOG) {
    const row = await prisma.module.upsert({
      where: { name: definition.name },
      update: { description: definition.description, sortOrder: definition.sortOrder },
      create: {
        name: definition.name,
        description: definition.description,
        sortOrder: definition.sortOrder,
      },
      select: { id: true },
    });
    moduleIds.set(definition.name, row.id);
  }

  const permissionIds = new Map<string, string>();
  for (const definition of PERMISSION_CATALOG) {
    for (const permission of definition.permissions) {
      const row = await prisma.permission.upsert({
        where: { name: permission.name },
        update: { description: permission.description, moduleId: moduleIds.get(definition.name) },
        create: {
          name: permission.name,
          description: permission.description,
          moduleId: moduleIds.get(definition.name),
        },
        select: { id: true },
      });
      permissionIds.set(permission.name, row.id);
    }
  }

  const permissionsOfModule = new Map<string, string[]>();
  for (const definition of PERMISSION_CATALOG) {
    permissionsOfModule.set(
      definition.name,
      definition.permissions.map((p) => permissionIds.get(p.name) as string),
    );
  }

  const roleIds: Record<string, string> = {};
  for (const role of SYSTEM_ROLES) {
    const row = await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description, isSystem: true },
      create: { name: role.name, description: role.description, isSystem: true },
      select: { id: true },
    });
    roleIds[role.name] = row.id;

    const wanted = new Set<string>();
    for (const moduleName of role.modules) {
      for (const id of permissionsOfModule.get(moduleName) ?? []) {
        wanted.add(id);
      }
    }
    for (const permissionName of role.permissions) {
      const id = permissionIds.get(permissionName);
      if (!id) {
        throw new Error(
          `System role "${role.name}" grants unknown permission "${permissionName}". ` +
            'Add it to PERMISSION_CATALOG first.',
        );
      }
      wanted.add(id);
    }

    for (const permissionId of wanted) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: row.id, permissionId } },
        update: {},
        create: { roleId: row.id, permissionId },
      });
    }
  }

  return roleIds;
}

/**
 * Grants a role to a platform administrator.
 *
 * @param prisma Control-plane client.
 * @param adminId Administrator primary key.
 * @param roleId Role to grant.
 */
export async function grantPlatformRole(
  prisma: PrismaClient,
  adminId: string,
  roleId: string,
): Promise<void> {
  await prisma.platformAdminRole.upsert({
    where: { adminId_roleId: { adminId, roleId } },
    update: {},
    create: { adminId, roleId },
  });
}

/**
 * Grants roles to a tenant member inside the member's own schema.
 *
 * Uses the tenant client directly, with the `app.current_tenant` binding the
 * FORCE row-level policies require.
 *
 * @param tenantClient Client bound to the tenant schema.
 * @param schemaName Tenant schema, for the row-level binding.
 * @param userId Member primary key.
 * @param roleIds Roles to grant.
 */
export async function grantTenantRoles(
  tenantClient: TenantPlaneClient,
  schemaName: string,
  userId: string,
  roleIds: readonly string[],
): Promise<void> {
  await tenantClient.$transaction(async (tx) => {
    // eslint-disable-next-line no-restricted-properties -- SET LOCAL cannot bind a parameter; the value is the schema name just validated.
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${schemaName}'`);
    for (const roleId of roleIds) {
      await tx.userRole.upsert({
        where: { userId_roleId: { userId, roleId } },
        update: {},
        create: { userId, roleId },
      });
    }
  });
}
