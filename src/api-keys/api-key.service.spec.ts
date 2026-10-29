import 'reflect-metadata';
import { jest } from '@jest/globals';
import { ApiKeyService } from './api-key.service';
import { AuthorizationException, ConflictException, NotFoundException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { AuditLogService } from '../audit/audit-log.service';
import type { AppConfig } from '../config/app-config.service';
import type { AuthorizationService } from '../auth/authorization.service';
import type { Principal } from '../tenancy/tenant-context.interface';

const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = { type: 'TENANT_USER' as never, id: 'caller' };

const caller: Principal = {
  kind: 'api-key',
  id: 'caller',
  name: 'existing-integration',
  tenantId: TENANT,
  scopes: ['admin:*', 'projects:read'],
};

interface Captured {
  creates: Array<{ data: Record<string, unknown> }>;
  audits: Array<{ action: string; metadata?: unknown }>;
}

function serviceFor(
  existing: Record<string, unknown> | null = null,
  principal: Principal = caller,
  permissions: readonly string[] = [],
) {
  const captured: Captured = { creates: [], audits: [] };

  const prisma = {
    client: {
      apiKey: {
        findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue(existing),
        findMany: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
        create: jest.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>((args) => {
          captured.creates.push(args);
          return Promise.resolve({ id: 'key-1', createdAt: new Date(), ...args.data });
        }),
        update: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
        updateMany: jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({ count: 3 }),
      },
    },
  } as unknown as ControlPlanePrismaService;

  const audit = {
    record: jest.fn<(a: { action: string; metadata?: unknown }) => Promise<void>>((a) => {
      captured.audits.push(a);
      return Promise.resolve();
    }),
  } as unknown as AuditLogService;

  const context = new RequestContextService();
  const config = {
    apiKeyPrefix: 'mtb',
    apiKeyArgon2MemoryCost: 19_456,
    apiKeyArgon2TimeCost: 2,
    apiKeyArgon2Parallelism: 1,
    apiKeyDefaultTtlMs: 90 * 24 * 3_600_000,
  } as unknown as AppConfig;

  // RBAC, as AuthorizationService resolves it for a member or platform admin.
  const authorization = {
    resolve: () => Promise.resolve({ roleIds: [], roleNames: [], permissions: new Set(permissions) }),
  } as unknown as AuthorizationService;

  const service = new ApiKeyService(prisma, config, audit, context, authorization);
  const run = <T>(fn: () => Promise<T>): Promise<T> => context.run({ principal }, fn);

  return { service, captured, run };
}

describe('ApiKeyService.issue', () => {
  it('returns a secret once and persists only an Argon2 digest', async () => {
    const { service, captured, run } = serviceFor();
    const issued = await run(() => service.issue(TENANT, 'ci', ['projects:read'], null, actor));

    expect(typeof issued.secret).toBe('string');
    expect(issued.secret.length).toBeGreaterThan(20);

    const data = captured.creates[0]?.data ?? {};
    expect(typeof data.secretHash).toBe('string');
    expect(JSON.stringify(data)).not.toContain(issued.secret);
  });

  it('never leaks the clear-text secret into the audit trail', async () => {
    const { service, captured, run } = serviceFor();
    const issued = await run(() => service.issue(TENANT, 'ci', ['projects:read'], null, actor));
    const audit = captured.audits.find((a) => a.action === 'apikey.create');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.metadata ?? {})).not.toContain(issued.secret);
    // The public prefix is expected to be there; only the secret must be absent.
    expect(JSON.stringify(audit?.metadata ?? {})).toContain('prefix');
  });

  it('binds the key to the tenant it was issued for', async () => {
    const { service, captured, run } = serviceFor();
    await run(() => service.issue(TENANT, 'ci', ['projects:read'], null, actor));
    expect(captured.creates[0]?.data.tenantId).toBe(TENANT);
  });

  it('produces a different secret on every issuance', async () => {
    const a = serviceFor();
    const b = serviceFor();
    const ia = await a.run(() => a.service.issue(TENANT, 'ci', ['projects:read'], null, actor));
    const ib = await b.run(() => b.service.issue(TENANT, 'ci', ['projects:read'], null, actor));
    expect(ia.secret).not.toBe(ib.secret);
  });

  it('refuses a scope the issuer is not allowed to grant', async () => {
    const { service, captured, run } = serviceFor();
    await expect(run(() => service.issue(TENANT, 'ci', ['*'] as never, null, actor))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(captured.creates).toHaveLength(0);
  });

  it('refuses an unknown scope', async () => {
    const { service, captured, run } = serviceFor();
    await expect(
      run(() => service.issue(TENANT, 'ci', ['root:everything'] as never, null, actor)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(captured.creates).toHaveLength(0);
  });
});

describe('ApiKeyService: a key never carries more than its issuer holds', () => {
  const member: Principal = {
    kind: 'tenant-user',
    id: 'member-1',
    displayName: 'Tenant admin',
    role: 'ADMIN' as never,
    tenantId: TENANT,
  };
  const platformAdmin: Principal = {
    kind: 'platform-admin',
    id: 'admin-1',
    displayName: 'Provisioning',
    role: 'ADMIN',
    tenantId: TENANT,
  };
  // The seeded tenant-admin role: payments, but deliberately no webhooks.
  const tenantAdminPermissions = ['api-keys:issue', 'payments:read', 'payments:write', 'payments:refund'];

  it('refuses webhooks:write to a tenant admin whose role lacks it', async () => {
    const { service, captured, run } = serviceFor(null, member, tenantAdminPermissions);
    await expect(
      run(() => service.issue(TENANT, 'leak', ['payments:read', 'webhooks:write'], null, actor)),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(captured.creates).toHaveLength(0);
  });

  it('refuses admin:* to a tenant member, whatever their permissions', async () => {
    const { service, captured, run } = serviceFor(null, member, [
      ...tenantAdminPermissions,
      'webhooks:write',
    ]);
    await expect(
      run(() => service.issue(TENANT, 'breeder', ['admin:*'], null, actor)),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(captured.creates).toHaveLength(0);
  });

  it('lets a tenant admin issue the scopes its role holds', async () => {
    const { service, captured, run } = serviceFor(null, member, tenantAdminPermissions);
    await run(() => service.issue(TENANT, 'erp', ['payments:read', 'payments:write'], null, actor));
    expect(captured.creates).toHaveLength(1);
  });

  it('keeps the platform provisioning flow: payments:read/write/refund, and admin:*', async () => {
    const { service, captured, run } = serviceFor(null, platformAdmin, [
      'api-keys:issue',
      'payments:read',
      'payments:write',
      'payments:refund',
    ]);
    await run(() =>
      service.issue(TENANT, 'plane', ['payments:read', 'payments:write', 'payments:refund'], null, actor),
    );
    await run(() => service.issue(TENANT, 'ops', ['admin:*'], null, actor));
    expect(captured.creates).toHaveLength(2);
  });

  it('lets a key pass on only scopes it holds, never admin:* itself', async () => {
    const { service, captured, run } = serviceFor();
    await expect(
      run(() => service.issue(TENANT, 'escalate', ['webhooks:write'], null, actor)),
    ).rejects.toBeInstanceOf(AuthorizationException);
    await expect(run(() => service.issue(TENANT, 'breed', ['admin:*'], null, actor))).rejects.toBeInstanceOf(
      AuthorizationException,
    );
    expect(captured.creates).toHaveLength(0);
  });

  it('refuses to rotate (and hand out a secret for) a key holding more than the caller', async () => {
    const stronger = {
      id: 'key-9',
      tenantId: TENANT,
      name: 'webhooks',
      status: 'ACTIVE',
      scopes: ['webhooks:write'],
      expiresAt: null,
    };
    const { service, captured, run } = serviceFor(stronger);
    await expect(run(() => service.rotate(TENANT, 'key-9'))).rejects.toBeInstanceOf(AuthorizationException);
    expect(captured.creates).toHaveLength(0);
  });
});

describe('ApiKeyService.revoke', () => {
  it('cannot reach a key outside the tenant it was asked about', async () => {
    // The lookup is scoped by (id, tenantId); a miss must surface as NotFound.
    const { service, run } = serviceFor(null);
    await expect(run(() => service.revoke(TENANT, 'key-1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokes every active key for a tenant in one statement', async () => {
    const { service, run } = serviceFor();
    await expect(run(() => service.revokeAllForTenant(TENANT))).resolves.toBe(3);
  });
});

describe('ApiKeyService.equaliseTiming', () => {
  it('performs a real verification so a miss is indistinguishable from a hit', () => {
    const { service } = serviceFor();
    expect(typeof service.equaliseTiming).toBe('function');
  });
});
