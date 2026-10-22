import { jest } from '@jest/globals';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationService } from './authorization.service';
import { PermissionsGuard } from './permissions.guard';
import {
  ALL_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
  RequireAllPermissions,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import { AuthorizationException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import { PermissionCatalog, moduleNames } from './permission-catalog';
import type { Principal, TenantContext } from '../tenancy/tenant-context.interface';

const TENANT_A = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  slug: 'acme',
  name: 'ACME',
  status: 'ACTIVE',
  plan: 'enterprise',
  timezone: 'UTC',
  schemaName: 'tenant_acme_00000001',
  schemaVersion: 2,
  provisionedAt: new Date(),
  settings: {},
  activeApiKeyCount: 0,
  createdAt: new Date(),
} as unknown as TenantContext;

function tenantUser(role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'): Principal {
  return { kind: 'tenant-user', id: 'user-1', displayName: 'U', role, tenantId: TENANT_A.id };
}

function platformAdmin(role: 'OWNER' | 'ADMIN' | 'AUDITOR'): Principal {
  return { kind: 'platform-admin', id: 'admin-1', displayName: 'A', role, tenantId: null };
}

const apiKeyPrincipal: Principal = {
  kind: 'api-key',
  id: 'key-1',
  name: 'ci',
  tenantId: TENANT_A.id,
  scopes: ['projects:read'],
};

/**
 * Reads a decorated handler off a prototype without binding `this`.
 *
 * Decorators are applied to the prototype at class-definition time, so the
 * metadata lives there; going through `Reflect.get` keeps the reference
 * unbound without tripping the unbound-method rule.
 *
 * @param proto Prototype carrying the handler.
 * @returns The handler function.
 */
function handlerOf(proto: object): unknown {
  return Reflect.get(proto, 'handler') as unknown;
}

function ctxFor(): ExecutionContext {
  const req = { headers: {} };
  return {
    getHandler: () => function handler(): void {},
    getClass: () => class Probe {},
    switchToHttp: () => ({ getRequest: (): unknown => req }),
  } as unknown as ExecutionContext;
}

/**
 * Builds a guard whose principal resolves to `permissions`, plus a runner that
 * invokes it inside the request context the guard reads from.
 */
function guardWith(
  permissions: Set<string>,
  principal: Principal | null,
): { guard: PermissionsGuard; run: (ctx: ExecutionContext) => Promise<boolean> } {
  const reflector = new Reflector();
  const context = new RequestContextService();
  const authorization = {
    resolve: jest.fn<() => Promise<{ permissions: Set<string> }>>().mockResolvedValue({ permissions }),
  } as unknown as AuthorizationService;
  const guard = new PermissionsGuard(reflector, authorization, context);
  const base = principal ? { tenant: TENANT_A, principal } : { tenant: TENANT_A };
  return { guard, run: (ctx: ExecutionContext) => context.run(base, () => guard.canActivate(ctx)) };
}

describe('PermissionCatalog', () => {
  const catalog = new PermissionCatalog();

  it('groups every permission under a declared module', () => {
    for (const module of PERMISSION_CATALOG_EXPECTED) {
      for (const permission of module.permissions) {
        expect(catalog.isKnown(permission.name)).toBe(true);
        expect(catalog.moduleOf(permission.name)).toBe(module.name);
      }
    }
  });

  it('rejects an unknown permission instead of silently granting a dead name', () => {
    expect(catalog.isKnown('nope:fly')).toBe(false);
    expect(() => catalog.moduleOf('nope:fly')).toThrow(/Unknown permission/);
  });

  it('returns a map whose keys are exactly the declared modules', () => {
    const grouped = catalog.groupByModule(['api-keys:read', 'tenants:purge']);
    expect([...grouped.keys()].sort()).toEqual([...moduleNames()].sort());
    expect(grouped.get('api-keys')).toEqual(['api-keys:read']);
    expect(grouped.get('tenants')).toEqual(['tenants:purge']);
  });
});

// Imported lazily so the assertions above read as data, not as a second import.
import { PERMISSION_CATALOG as PERMISSION_CATALOG_EXPECTED } from './permission-catalog';

describe('RequirePermissions decorators', () => {
  it('refuse an empty permission list rather than removing authorization', () => {
    class Probe {
      handler(this: void): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!;
    expect(() => (RequirePermissions() as MethodDecorator)(Probe.prototype, 'handler', descriptor)).toThrow(
      /requires at least one permission/,
    );
    expect(() =>
      (RequireAllPermissions() as MethodDecorator)(Probe.prototype, 'handler', descriptor),
    ).toThrow(/requires at least one permission/);
  });
});

describe('PermissionsGuard', () => {
  it('leaves routes that declare nothing to the coarse controls', async () => {
    const { run } = guardWith(new Set(), tenantUser('VIEWER'));
    await expect(run(ctxFor())).resolves.toBe(true);
  });

  it('refuses a principal holding none of the accepted permissions', async () => {
    class Probe {
      @RequirePermissions('api-keys:issue')
      handler(this: void): void {}
    }
    const ctx = {
      getHandler: () => handlerOf(Probe.prototype),
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: (): unknown => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    const { run } = guardWith(new Set(['api-keys:read']), tenantUser('ADMIN'));
    await expect(run(ctx)).rejects.toBeInstanceOf(AuthorizationException);
  });

  it('admits a principal holding any one of the accepted permissions', async () => {
    class Probe {
      @RequirePermissions('api-keys:issue', 'api-keys:rotate')
      handler(this: void): void {}
    }
    const ctx = {
      getHandler: () => handlerOf(Probe.prototype),
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: (): unknown => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    const { run } = guardWith(new Set(['api-keys:rotate']), tenantUser('ADMIN'));
    await expect(run(ctx)).resolves.toBe(true);
  });

  it('requires every permission when all-of is declared', async () => {
    class Probe {
      @RequireAllPermissions('tenants:read', 'tenants:write')
      handler(this: void): void {}
    }
    const ctx = {
      getHandler: () => handlerOf(Probe.prototype),
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: (): unknown => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    const missing = guardWith(new Set(['tenants:read']), platformAdmin('ADMIN'));
    await expect(missing.run(ctx)).rejects.toBeInstanceOf(AuthorizationException);
    const complete = guardWith(new Set(['tenants:read', 'tenants:write']), platformAdmin('ADMIN'));
    await expect(complete.run(ctx)).resolves.toBe(true);
  });

  it('reads class-level declarations too', async () => {
    class Probe {
      @RequirePermissions('users:read')
      handler(this: void): void {}
    }
    const ctx = {
      getHandler: () => handlerOf(Probe.prototype),
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: (): unknown => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    const { run } = guardWith(new Set(['users:read']), tenantUser('ADMIN'));
    await expect(run(ctx)).resolves.toBe(true);
  });

  it('defers API-key principals to the scope guard', async () => {
    class Probe {
      @RequirePermissions('api-keys:issue')
      handler(this: void): void {}
    }
    const ctx = {
      getHandler: () => handlerOf(Probe.prototype),
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: (): unknown => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    // A key holds no roles, so asking the RBAC catalogue about one would report
    // the wrong reason for a denial. `ApiKeyScopesGuard` is the authority there.
    const { run } = guardWith(new Set(), apiKeyPrincipal);
    await expect(run(ctx)).resolves.toBe(true);
  });

  it('exposes the metadata keys it reads', () => {
    expect(PERMISSIONS_KEY).toBe('auth:permissions');
    expect(ALL_PERMISSIONS_KEY).toBe('auth:allPermissions');
  });
});

describe('AuthorizationService', () => {
  it('unions the permissions of every role a principal holds', async () => {
    const roles = [
      { id: 'r1', name: 'reader', permissions: [{ permission: { name: 'projects:read' } }] },
      { id: 'r2', name: 'key-admin', permissions: [{ permission: { name: 'api-keys:issue' } }] },
    ];
    const controlPlane = {
      client: {
        platformAdminRole: {
          findMany: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValue(roles.map((r) => ({ adminId: 'admin-1', role: r }))),
        },
      },
    } as unknown as ConstructorParameters<typeof AuthorizationService>[0];
    const tenantPlane = {} as ConstructorParameters<typeof AuthorizationService>[1];
    const service = new AuthorizationService(controlPlane, tenantPlane);
    service.maxEntries = 10;

    const authority = await service.resolve(platformAdmin('ADMIN'));
    // Multiple roles per user: the effective set is the union, not the first role.
    expect([...authority.permissions].sort()).toEqual(['api-keys:issue', 'projects:read']);
    expect([...authority.roleNames].sort()).toEqual(['key-admin', 'reader']);
  });

  it('caches per principal and per tenant', async () => {
    const findMany = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    const controlPlane = {
      client: { platformAdminRole: { findMany } },
    } as unknown as ConstructorParameters<typeof AuthorizationService>[0];
    const tenantPlane = {} as ConstructorParameters<typeof AuthorizationService>[1];
    const service = new AuthorizationService(controlPlane, tenantPlane);
    service.ttlMs = 60_000;
    service.maxEntries = 10;

    await service.resolve(platformAdmin('ADMIN'));
    await service.resolve(platformAdmin('ADMIN'));
    expect(findMany).toHaveBeenCalledTimes(1);

    service.invalidate(platformAdmin('ADMIN'));
    await service.resolve(platformAdmin('ADMIN'));
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('re-reads roles within 5 s by default, so a revocation propagates (BN-REQ-SEC-012)', async () => {
    const findMany = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    const controlPlane = {
      client: { platformAdminRole: { findMany } },
    } as unknown as ConstructorParameters<typeof AuthorizationService>[0];
    const service = new AuthorizationService(
      controlPlane,
      {} as ConstructorParameters<typeof AuthorizationService>[1],
    );
    expect(service.ttlMs).toBeLessThanOrEqual(5_000);
    const now = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    await service.resolve(platformAdmin('ADMIN'));
    now.mockReturnValue(5_000_000 + 5_001);
    await service.resolve(platformAdmin('ADMIN'));
    expect(findMany).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('takes its TTL from AUTHZ_CACHE_TTL_MS when configured', () => {
    const service = new AuthorizationService(
      {} as ConstructorParameters<typeof AuthorizationService>[0],
      {} as ConstructorParameters<typeof AuthorizationService>[1],
      { authzCacheTtlMs: 1_500 } as ConstructorParameters<typeof AuthorizationService>[2],
    );
    expect(service.ttlMs).toBe(1_500);
  });

  it('returns no authority for an API key', async () => {
    const controlPlane = {} as ConstructorParameters<typeof AuthorizationService>[0];
    const tenantPlane = {} as ConstructorParameters<typeof AuthorizationService>[1];
    const service = new AuthorizationService(controlPlane, tenantPlane);
    service.maxEntries = 10;
    const authority = await service.resolve(apiKeyPrincipal);
    expect(authority.permissions.size).toBe(0);
    expect(authority.roleIds).toEqual([]);
  });
});
