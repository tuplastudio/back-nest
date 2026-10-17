import { Injectable } from '@nestjs/common';
import { DomainException } from '../common/errors/app.exception';

/**
 * Permission naming, and the module grouping that is stored alongside it.
 *
 * The model is deliberately narrow:
 *
 *   Module      groups permissions. Nothing else. It confers no authority.
 *   Permission  one atomic authority, belonging to a module.
 *   Role        holds permissions, through `RolePermission`.
 *   User        holds roles, through `UserRole`.
 *
 * A user may hold any number of roles; its effective permissions are the union of
 * the permissions of those roles. Modules are organisational and never appear in
 * that union, which is why there is no `RoleModule` join: a role holds
 * permissions, not modules.
 */

/** Separator between the resource and the action in a permission name. */
export const PERMISSION_SEPARATOR = ':';

/**
 * One module and the permissions it groups.
 */
export interface ModuleDefinition {
  /** Module key, e.g. `api-keys`. */
  readonly name: string;
  /** Human readable description. */
  readonly description: string;
  /** Display order in a console; lower sorts first. */
  readonly sortOrder: number;
  /** Permissions grouped under this module. */
  readonly permissions: readonly { readonly name: string; readonly description: string }[];
}

/**
 * The permission catalogue a deployment ships with, grouped by module.
 *
 * Seeding and admin tooling both read this single definition, so the database
 * and the code cannot disagree about which permissions exist.
 */
export const PERMISSION_CATALOG: readonly ModuleDefinition[] = [
  {
    name: 'tenants',
    description: 'Tenant registry lifecycle',
    sortOrder: 10,
    permissions: [
      { name: 'tenants:read', description: 'List and inspect tenants' },
      { name: 'tenants:write', description: 'Create and update tenants' },
      { name: 'tenants:suspend', description: 'Suspend and reactivate tenants' },
      { name: 'tenants:migrate', description: 'Apply pending tenant migrations' },
      { name: 'tenants:delete', description: 'Soft-delete a tenant' },
      { name: 'tenants:purge', description: 'Irreversibly drop a tenant schema' },
    ],
  },
  {
    name: 'api-keys',
    description: 'Tenant API key credentials',
    sortOrder: 20,
    permissions: [
      { name: 'api-keys:read', description: 'List tenant API keys' },
      { name: 'api-keys:issue', description: 'Issue a tenant API key' },
      { name: 'api-keys:rotate', description: 'Rotate a tenant API key' },
      { name: 'api-keys:revoke', description: 'Revoke a tenant API key' },
    ],
  },
  {
    name: 'users',
    description: 'Tenant membership',
    sortOrder: 30,
    permissions: [
      { name: 'users:read', description: 'List and inspect tenant members' },
      { name: 'users:write', description: 'Create and manage tenant members' },
    ],
  },
  {
    name: 'projects',
    description: 'Tenant resources',
    sortOrder: 40,
    permissions: [
      { name: 'projects:read', description: 'Read tenant projects' },
      { name: 'projects:write', description: 'Create, update and delete tenant projects' },
    ],
  },
  {
    name: 'payments',
    description: 'Payment provider configuration and orders',
    sortOrder: 60,
    permissions: [
      { name: 'payments:read', description: 'Read payment orders' },
      { name: 'payments:write', description: 'Create payment orders' },
      { name: 'payments:refund', description: 'Refund a settled payment' },
      {
        name: 'payments:configure',
        description: "Store this tenant's Netpay credentials and webhook token",
      },
    ],
  },
  {
    name: 'webhooks',
    description: 'Outbound notifications to other platforms',
    sortOrder: 70,
    permissions: [
      { name: 'webhooks:read', description: 'Read outbound endpoints and deliveries' },
      {
        name: 'webhooks:write',
        description: 'Register an outbound destination and enable or disable it',
      },
      { name: 'webhooks:rotate-secret', description: 'Rotate an endpoint signing secret' },
      { name: 'webhooks:replay', description: 'Re-queue an outbound delivery' },
    ],
  },
  {
    name: 'audit',
    description: 'Audit trail',
    sortOrder: 80,
    permissions: [{ name: 'audit:read', description: 'Read the audit trail' }],
  },
];

/**
 * Every permission name in the catalogue, in module order.
 *
 * @returns Flat list of permission names.
 */
export function allPermissionNames(): string[] {
  return PERMISSION_CATALOG.flatMap((m) => m.permissions.map((p) => p.name));
}

/**
 * Module keys in the catalogue.
 *
 * @returns Module names.
 */
export function moduleNames(): string[] {
  return PERMISSION_CATALOG.map((m) => m.name);
}

/**
 * Looks a permission definition up by name.
 *
 * @param name Permission name, e.g. `api-keys:issue`.
 * @returns The definition, or `undefined` when the permission is unknown.
 */
export function findPermission(name: string): { name: string; description: string } | undefined {
  for (const module of PERMISSION_CATALOG) {
    const hit = module.permissions.find((p) => p.name === name);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * In-memory helper over the catalogue rules.
 */
@Injectable()
export class PermissionCatalog {
  private readonly permissionsByName: ReadonlyMap<string, { module: string; description: string }>;
  private readonly moduleOrder: readonly string[];

  constructor() {
    const map = new Map<string, { module: string; description: string }>();
    for (const module of PERMISSION_CATALOG) {
      for (const permission of module.permissions) {
        map.set(permission.name, { module: module.name, description: permission.description });
      }
    }
    this.permissionsByName = map;
    this.moduleOrder = moduleNames();
  }

  /**
   * @param name Permission name to check.
   * @returns `true` when the permission exists in the catalogue.
   */
  isKnown(name: string): boolean {
    return this.permissionsByName.has(name);
  }

  /**
   * @param name Permission name to resolve.
   * @returns The module that groups it.
   * @throws {ApplicationError} When the permission is unknown.
   */
  moduleOf(name: string): string {
    const entry = this.permissionsByName.get(name);
    if (entry === undefined) {
      throw new DomainException(
        `Unknown permission "${name}". Granting an unknown permission would silently create authority that no role can exercise.`,
      );
    }
    return entry.module;
  }

  /**
   * Groups arbitrary permission names by module, for console rendering.
   *
   * Unknown names are returned under their literal prefix so a stale grant is
   * visible rather than dropped.
   *
   * @param names Permission names to group.
   * @returns Permission names keyed by module.
   */
  groupByModule(names: Iterable<string>): Map<string, string[]> {
    const grouped = new Map<string, string[]>(this.moduleOrder.map((m) => [m, []]));
    for (const name of names) {
      const entry = this.permissionsByName.get(name);
      const key = entry?.module ?? name.split(PERMISSION_SEPARATOR)[0] ?? name;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(name);
    }
    return grouped;
  }
}
