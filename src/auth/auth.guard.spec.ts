import 'reflect-metadata';
import { jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { ROLES_KEY, Roles } from '../common/decorators/roles.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AuthorizationException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import { MemberRole } from '../generated/tenant-plane/enums';
import type { Principal, TenantContext } from '../tenancy/tenant-context.interface';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ApiKeyService } from '../api-keys/api-key.service';
import type { TokenService } from './token.service';

type PlatformRole = 'OWNER' | 'ADMIN' | 'AUDITOR';
type AdminRow = { id: string; displayName: string; role: PlatformRole; status: string };
type ApiKeyRow = {
  id: string;
  name: string;
  tenantId: string;
  secretHash: string;
  scopes: string[];
  status: string;
  expiresAt: Date | null;
  tenant: { status: string };
};
type MemberRow = {
  id: string;
  displayName: string;
  role: MemberRole;
  status: string;
  deletedAt: Date | null;
};

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const tenantContext = (id: string, slug: string, schemaName: string): TenantContext => ({
  id,
  slug,
  name: slug.toUpperCase(),
  schemaName,
  status: 'ACTIVE',
  plan: 'standard',
  timezone: 'UTC',
  locale: 'en',
  resolvedAt: Date.now(),
});

const platformAdmin = (role: PlatformRole): Principal => ({
  kind: 'platform-admin',
  id: 'admin-1',
  displayName: 'Root',
  role,
  tenantId: null,
});

const tenantUser = (role: MemberRole): Principal => ({
  kind: 'tenant-user',
  id: 'member-1',
  displayName: 'Member',
  role,
  tenantId: TENANT_A,
});

const apiKeyPrincipal: Principal = {
  kind: 'api-key',
  id: 'key-1',
  name: 'integration',
  tenantId: TENANT_A,
  scopes: ['projects:read'],
};

/** A syntactically valid API key bearer token for `API_KEY_PATTERN`. */
const API_KEY_TOKEN = `mtb_abcdefgh_${'A'.repeat(43)}`;

/**
 * Guard wired so the *real* authentication branch for `principal` succeeds, so the
 * only thing under test is the `@Roles` decision that follows it.
 */
function guardFor(principal: Principal, required: readonly PlatformRole[]) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) => (key === ROLES_KEY ? [...required] : undefined));

  const tokens = {
    verifyAccessToken: jest.fn().mockReturnValue({ sub: principal.id, kind: principal.kind }),
  } as unknown as TokenService;

  const controlPlane = {
    client: {
      platformAdmin: {
        findUnique: jest
          .fn<() => Promise<AdminRow | null>>()
          .mockResolvedValue(
            principal.kind === 'platform-admin'
              ? { id: principal.id, displayName: 'Root', role: principal.role, status: 'ACTIVE' }
              : null,
          ),
      },
      apiKey: {
        findUnique: jest.fn<() => Promise<ApiKeyRow | null>>().mockResolvedValue(
          principal.kind === 'api-key'
            ? {
                id: principal.id,
                name: principal.name,
                tenantId: principal.tenantId,
                secretHash: 'argon2-hash',
                scopes: [...principal.scopes],
                status: 'ACTIVE',
                expiresAt: null,
                tenant: { status: 'ACTIVE' },
              }
            : null,
        ),
      },
    },
  } as unknown as ControlPlanePrismaService;

  const tenantPrisma = {
    // Row-level security means the guard reads the member row through a
    // tenant-bound transaction, not the raw client.
    forTenantTransaction: jest.fn<(s: string, cb: (c: unknown) => Promise<unknown>) => Promise<unknown>>(
      (_schema: string, cb: (c: unknown) => Promise<unknown>) =>
        cb({
          user: {
            findUnique: jest.fn<() => Promise<MemberRow | null>>().mockResolvedValue(
              principal.kind === 'tenant-user'
                ? {
                    id: principal.id,
                    displayName: 'Member',
                    role: principal.role,
                    status: 'ACTIVE',
                    deletedAt: null,
                  }
                : null,
            ),
          },
        }),
    ),
  } as unknown as TenantPrismaService;

  const apiKeys = {
    verifySecret: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    equaliseTiming: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    touchUsage: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as ApiKeyService;

  const context = new RequestContextService();
  const guard = new AuthGuard(reflector, context, controlPlane, tenantPrisma, apiKeys, tokens);

  // Applied only when roles are supplied: an empty `@Roles()` is now rejected at
  // decoration time, so the "no roles metadata" case must be expressed by
  // genuinely leaving the decorator off.
  class Probe {
    handler(): void {}
  }
  if (required.length > 0) {
    const methodDescriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!;
    (Roles(...required) as MethodDecorator)(Probe.prototype, 'handler', methodDescriptor);
  }
  const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!;
  const bearer = principal.kind === 'api-key' ? API_KEY_TOKEN : 'jwt-token';
  const ctx = {
    getHandler: () => descriptor.value as () => void,
    getClass: () => Probe,
    switchToHttp: () => ({
      getRequest: (): { headers: Record<string, string> } => ({
        headers: { authorization: `Bearer ${bearer}` },
      }),
    }),
  } as unknown as ExecutionContext;

  return { guard, ctx, context };
}

class ProbeTarget {
  handler(this: void): void {}
}

describe('AuthGuard.assertRole (regression: platform @Roles must reject tenant principals)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each<[MemberRole, readonly PlatformRole[]]>([
    [MemberRole.OWNER, ['OWNER']],
    [MemberRole.ADMIN, ['OWNER', 'ADMIN']],
    // A tenant MEMBER/VIEWER must also be refused; they were refused before the
    // fix too, and must stay refused.
    [MemberRole.MEMBER, ['OWNER', 'ADMIN', 'AUDITOR']],
    [MemberRole.VIEWER, ['OWNER', 'ADMIN', 'AUDITOR']],
  ])('refuses a tenant-user whose tenant role is %s', async (role, required) => {
    const { guard, ctx, context } = guardFor(tenantUser(role), required);
    await expect(
      context.run({ tenant: tenantContext(TENANT_A, 'a', 'tenant_a') }, () => guard.canActivate(ctx)),
    ).rejects.toBeInstanceOf(AuthorizationException);
  });

  it.each(Object.values(MemberRole))('refuses tenant role %s on @Roles("OWNER")', async (role) => {
    const { guard, ctx, context } = guardFor(tenantUser(role), ['OWNER']);
    await expect(
      context.run({ tenant: tenantContext(TENANT_A, 'a', 'tenant_a') }, () => guard.canActivate(ctx)),
    ).rejects.toBeInstanceOf(AuthorizationException);
  });

  it('refuses a tenant-user ADMIN on @Roles("OWNER") too', async () => {
    const { guard, ctx, context } = guardFor(tenantUser(MemberRole.ADMIN), ['OWNER']);
    await expect(
      context.run({ tenant: tenantContext(TENANT_A, 'a', 'tenant_a') }, () => guard.canActivate(ctx)),
    ).rejects.toBeInstanceOf(AuthorizationException);
  });

  it('still admits a genuine platform OWNER', async () => {
    const { guard, ctx, context } = guardFor(platformAdmin('OWNER'), ['OWNER']);
    await expect(context.run({}, () => guard.canActivate(ctx))).resolves.toBe(true);
  });

  it('still refuses a platform administrator whose role is not permitted', async () => {
    const { guard, ctx, context } = guardFor(platformAdmin('AUDITOR'), ['OWNER']);
    await expect(context.run({}, () => guard.canActivate(ctx))).rejects.toBeInstanceOf(
      AuthorizationException,
    );
  });

  it('refuses an api-key principal on a @Roles route', async () => {
    const { guard, ctx, context } = guardFor(apiKeyPrincipal, ['OWNER', 'ADMIN']);
    await expect(
      context.run({ tenant: tenantContext(TENANT_A, 'a', 'tenant_a') }, () => guard.canActivate(ctx)),
    ).rejects.toBeInstanceOf(AuthorizationException);
  });

  it('leaves routes without @Roles metadata unaffected', async () => {
    const { guard, ctx, context } = guardFor(tenantUser(MemberRole.VIEWER), []);
    await expect(
      context.run({ tenant: tenantContext(TENANT_A, 'a', 'tenant_a') }, () => guard.canActivate(ctx)),
    ).resolves.toBe(true);
  });

  it('refuses an empty @Roles() instead of stripping authorization from the route', () => {
    // Regression: the authorization gaps this codebase has had came from a route
    // that simply carried no role metadata, which `assertRole` treats as "no
    // restriction". `@Roles()` must therefore fail loudly rather than reproduce
    // that state by accident.
    const descriptor = Object.getOwnPropertyDescriptor(ProbeTarget.prototype, 'handler')!;
    expect(() => (Roles() as MethodDecorator)(ProbeTarget.prototype, 'handler', descriptor)).toThrow(
      /requires at least one role/,
    );
    expect(() =>
      (RequirePermissions() as MethodDecorator)(ProbeTarget.prototype, 'handler', descriptor),
    ).toThrow(/requires at least one permission/);
  });

  it('cannot be steered by addressing a different tenant', async () => {
    const { guard, ctx, context } = guardFor(tenantUser(MemberRole.ADMIN), ['OWNER', 'ADMIN']);
    await expect(
      context.run({ tenant: tenantContext(TENANT_B, 'b', 'tenant_b') }, () => guard.canActivate(ctx)),
    ).rejects.toBeInstanceOf(AuthorizationException);
  });
});
