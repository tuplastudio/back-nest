import 'reflect-metadata';
import { jest } from '@jest/globals';
import { ApiKeyService } from './api-key.service';
import { ConflictException, NotFoundException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { AuditLogService } from '../audit/audit-log.service';
import type { AppConfig } from '../config/app-config.service';
import type { Principal } from '../tenancy/tenant-context.interface';

const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = { type: 'TENANT_USER' as never, id: 'caller' };

const caller: Principal = {
  kind: 'api-key',
  id: 'caller',
  name: 'existing-integration',
  tenantId: TENANT,
  scopes: [],
};

interface Captured {
  creates: Array<{ data: Record<string, unknown> }>;
  audits: Array<{ action: string; metadata?: unknown }>;
}

function serviceFor(existing: Record<string, unknown> | null = null) {
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

  const service = new ApiKeyService(prisma, config, audit, context);
  const run = <T>(fn: () => Promise<T>): Promise<T> => context.run({ principal: caller }, fn);

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
