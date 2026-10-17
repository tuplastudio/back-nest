import { Injectable } from '@nestjs/common';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { Principal } from '../tenancy/tenant-context.interface';

/**
 * A caller's effective permissions, together with the roles they came from.
 */
export interface EffectiveAuthority {
  /** Role ids the principal currently holds. */
  readonly roleIds: readonly string[];
  /** Role names, for audit and for console display. */
  readonly roleNames: readonly string[];
  /** Union of the permissions granted by every held role. */
  readonly permissions: ReadonlySet<string>;
}

/** Empty authority, used when a principal holds no role. */
const NO_AUTHORITY: EffectiveAuthority = {
  roleIds: [],
  roleNames: [],
  permissions: new Set<string>(),
};

interface CacheEntry {
  readonly at: number;
  readonly authority: EffectiveAuthority;
}

/**
 * Resolves the permissions a principal actually holds.
 *
 * Resolution follows the model rather than the token: a principal holds roles
 * (`platform_admin_roles` in the control plane, `user_roles` in the tenant
 * schema), a role holds permissions (`role_permissions`), and the effective set
 * is the union across every held role.
 *
 * Roles are deliberately *not* carried in the access token, matching the
 * existing session design: revoking a role takes effect on the next request
 * rather than at the next sign-in. Results are cached briefly to keep one
 * request from turning into several catalogue queries, and {@link invalidate}
 * lets a grant or revocation drop the entry immediately.
 */
@Injectable()
export class AuthorizationService {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * @param controlPlane Control-plane client, holding the role catalogue.
   * @param tenantPlane Tenant-bound client, holding `user_roles`.
   * @param ttlMs How long a resolved authority may be reused.
   * @param maxEntries Upper bound on cached authorities.
   */
  /**
   * How long a resolved authority may be reused before it is re-read.
   *
   * A field rather than a constructor parameter on purpose: Nest resolves
   * constructor parameters from `design:paramtypes`, and a `number` parameter
   * with a default value still produces a `Number` dependency the injector
   * cannot satisfy. Tests override these two fields directly.
   */
  ttlMs = 30_000;

  /** Upper bound on cached authorities, evicted least-recently-used first. */
  maxEntries = 5_000;

  constructor(
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly tenantPlane: TenantPrismaService,
  ) {}

  /**
   * Resolves the effective authority of a principal.
   *
   * API keys are machine principals: their authority is the scope set, which
   * {@link ApiKeyScopesGuard} already enforces. Resolving RBAC roles for them
   * would return nothing and misreport why access was granted, so they are
   * answered with an empty authority and documented as out of scope here.
   *
   * @param principal Authenticated principal.
   * @returns The principal's roles and their union of permissions.
   */
  async resolve(principal: Principal): Promise<EffectiveAuthority> {
    if (principal.kind === 'api-key') {
      return NO_AUTHORITY;
    }
    const cacheKey = principalCacheKey(principal);
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) {
      return hit.authority;
    }
    const authority =
      principal.kind === 'platform-admin'
        ? await this.resolvePlatformAdmin(principal.id)
        : await this.resolveTenantUser(principal.id);
    this.remember(cacheKey, authority);
    return authority;
  }

  /**
   * Drops a cached authority, so a grant or revocation applies immediately.
   *
   * @param principal Principal whose authority changed.
   */
  invalidate(principal: Principal): void {
    this.cache.delete(principalCacheKey(principal));
  }

  /**
   * Empties the cache. Used by tests and by administrative tooling that bulk
   * edits role assignments.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Reads the roles of a platform administrator from the control plane.
   *
   * @param adminId Administrator primary key.
   * @returns Effective authority.
   */
  private async resolvePlatformAdmin(adminId: string): Promise<EffectiveAuthority> {
    const assignments = await this.controlPlane.client.platformAdminRole.findMany({
      where: { adminId },
      select: {
        role: {
          select: {
            id: true,
            name: true,
            permissions: { select: { permission: { select: { name: true } } } },
          },
        },
      },
    });
    return fold(assignments.map((a) => a.role));
  }

  /**
   * Reads a tenant member's roles from the tenant schema and resolves the
   * catalogue in the control plane.
   *
   * The two queries cannot be joined: the assignment and the catalogue live in
   * different schemas by design, so the tenant schema yields role ids and the
   * control plane turns them into permissions.
   *
   * @param userId Tenant member primary key.
   * @returns Effective authority.
   */
  private async resolveTenantUser(userId: string): Promise<EffectiveAuthority> {
    const assignments = await this.tenantPlane.forCurrentTenantTransaction((client) =>
      client.userRole.findMany({
        where: { userId },
        select: { roleId: true },
      }),
    );
    if (assignments.length === 0) {
      return NO_AUTHORITY;
    }
    const roles = await this.controlPlane.client.role.findMany({
      where: { id: { in: assignments.map((a) => a.roleId) } },
      select: {
        id: true,
        name: true,
        permissions: { select: { permission: { select: { name: true } } } },
      },
    });
    return fold(roles);
  }

  /**
   * Stores an authority, evicting the oldest entry when full.
   *
   * @param cacheKey Principal identity.
   * @param authority Resolved authority.
   */
  private remember(cacheKey: string, authority: EffectiveAuthority): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(cacheKey, { at: Date.now(), authority });
  }
}

interface RoleProjection {
  id: string;
  name: string;
  permissions: { permission: { name: string } }[];
}

/**
 * Unions role rows into a single authority.
 *
 * @param roles Roles held by the principal.
 * @returns The union of their permissions.
 */
function fold(roles: RoleProjection[]): EffectiveAuthority {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const link of role.permissions) {
      permissions.add(link.permission.name);
    }
  }
  return {
    roleIds: roles.map((r) => r.id),
    roleNames: roles.map((r) => r.name),
    permissions,
  };
}

/**
 * Builds the cache key for a principal.
 *
 * Tenant members are cached per tenant as well as per user: the same user id in
 * two schemas is two different authorities.
 *
 * @param principal Authenticated principal.
 * @returns Stable cache key.
 */
function principalCacheKey(principal: Principal): string {
  return principal.kind === 'tenant-user'
    ? `tenant-user:${principal.tenantId}:${principal.id}`
    : `${principal.kind}:${principal.id}`;
}
