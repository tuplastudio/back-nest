import 'reflect-metadata';
import { jest } from '@jest/globals';
import { TenantProvisioningException } from './tenant-provisioner.service';
import { TenantProvisionerService } from './tenant-provisioner.service';
import { TenantSchemaNamingService } from './tenant-schema-naming.service';
import { SafeSqlService } from '../prisma/safe-sql.service';
import { RequestContextService } from './request-context.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { TenantResolverService } from './tenant-resolver.service';
import type { AuditLogService } from '../audit/audit-log.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
type TenantRow = { id: string; slug: string; schemaName: string };

/** Provisions a dropSchema call whose registry row carries `schemaName`. */
function provisionerFor(schemaName: string, found = true) {
  const rawCalls: string[] = [];
  const evictions: string[] = [];
  const invalidations: Array<{ id: string; slug: string }> = [];

  const prisma = {
    client: {
      tenant: {
        findUnique: jest
          .fn<() => Promise<TenantRow | null>>()
          .mockResolvedValue(found ? { id: TENANT_ID, slug: 'acme', schemaName } : null),
      },
      $executeRawUnsafe: jest.fn<(sql: string) => Promise<number>>().mockImplementation((sql: string) => {
        rawCalls.push(sql);
        return Promise.resolve(0);
      }),
    },
  } as unknown as ControlPlanePrismaService;

  const tenantPrisma = {
    evict: jest.fn<(name: string) => void>().mockImplementation((name: string) => {
      evictions.push(name);
    }),
  } as unknown as TenantPrismaService;

  const resolver = {
    invalidate: jest.fn<(t: { id: string; slug: string }) => void>().mockImplementation((t) => {
      invalidations.push(t);
    }),
  } as unknown as TenantResolverService;

  const audit = {
    record: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as AuditLogService;

  // A real context, so requestMeta()/actor attribution behave as they do in
  // production; the calls are driven inside context.run(...) below.
  const context = new RequestContextService();

  const service = new TenantProvisionerService(
    prisma,
    tenantPrisma,
    resolver,
    new TenantSchemaNamingService(),
    audit,
    new SafeSqlService(),
    context,
  );

  const drop = (id: string) =>
    context.run({ requestId: 'req-1', ipHash: null, userAgentHash: null, principal: null }, () =>
      service.dropSchema(id),
    );

  return { drop, rawCalls, evictions, invalidations };
}

describe('TenantProvisionerService.dropSchema (regression: stored schema name is namespace-checked)', () => {
  it('drops a well-formed tenant schema', async () => {
    const { drop, rawCalls, evictions } = provisionerFor('tenant_acme_1a2b3c4d');
    await drop(TENANT_ID);
    expect(rawCalls).toEqual(['DROP SCHEMA IF EXISTS "tenant_acme_1a2b3c4d" CASCADE']);
    expect(evictions).toEqual(['tenant_acme_1a2b3c4d']);
  });

  it.each(['public', 'pg_catalog', 'information_schema'])(
    'refuses to aim destructive DDL at %s',
    async (schemaName) => {
      const { drop, rawCalls } = provisionerFor(schemaName);
      await expect(drop(TENANT_ID)).rejects.toBeInstanceOf(TenantProvisioningException);
      expect(rawCalls).toHaveLength(0);
    },
  );

  it('names the offending value in the error so the bad row is diagnosable', async () => {
    const { drop } = provisionerFor('public');
    await expect(drop(TENANT_ID)).rejects.toThrow(/outside the reserved tenant_ namespace/);
  });

  it('invalidates the resolver cache for both key shapes after a drop', async () => {
    const { drop, invalidations } = provisionerFor('tenant_acme_1a2b3c4d');
    await drop(TENANT_ID);
    expect(invalidations).toEqual([{ id: TENANT_ID, slug: 'acme' }]);
  });

  it('still throws for an unknown tenant before touching SQL', async () => {
    const { drop, rawCalls, invalidations } = provisionerFor('tenant_acme_1a2b3c4d', false);
    await expect(drop(TENANT_ID)).rejects.toBeInstanceOf(TenantProvisioningException);
    expect(rawCalls).toHaveLength(0);
    expect(invalidations).toHaveLength(0);
  });
});

describe('TenantSchemaNamingService.isValidSchemaName (the control dropSchema now applies)', () => {
  const naming = new TenantSchemaNamingService();

  it('rejects every non-tenant schema name', () => {
    for (const name of ['public', 'pg_catalog', 'information_schema', 'pg_temp_1', 'PUBLIC', '']) {
      expect(naming.isValidSchemaName(name)).toBe(false);
    }
  });

  it('accepts a derived tenant schema name', () => {
    expect(naming.isValidSchemaName(naming.toSchemaName('acme'))).toBe(true);
  });
});
