import { describe, expect, it, jest } from '@jest/globals';
import { PaymentConfigService } from './payment-config.service';
import { PaymentSecretBox } from './payment-secret-box';
import type { NetpayClient } from './netpay.client';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { AuditLogService } from '../audit/audit-log.service';

/**
 * Versioned payment configuration (BN-TASK-024, BN-REQ-CFG-002/003) and the
 * per-tenant allowlists it carries (BN-TASK-021/022).
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const box = new PaymentSecretBox(Buffer.alloc(32, 7).toString('base64'));

type Row = Record<string, unknown> & { id: string; version: number; active: boolean };

function fixture(rows: Row[] = []) {
  const table: Row[] = [...rows];
  const select = (row: Row | undefined) => (row === undefined ? null : { ...row });
  const client = {
    paymentProviderConfig: {
      findFirst: jest.fn((args: { where?: Record<string, unknown> } = {}) => {
        const where = args.where ?? {};
        if (typeof where['id'] === 'string') {
          return Promise.resolve(select(table.find((r) => r.id === where['id'])));
        }
        const active = table.filter((r) => r.active);
        const newest = [...(active.length > 0 ? active : table)].sort((a, b) => b.version - a.version)[0];
        return Promise.resolve(select(newest));
      }),
      updateMany: jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of table) {
          if (args.where['active'] === true && row.active) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }),
      update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = table.find((r) => r.id === args.where.id) as Row;
        Object.assign(row, args.data);
        return Promise.resolve({ ...row });
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        const row = { id: `cfg-${table.length + 1}`, ...args.data } as Row;
        table.push(row);
        return Promise.resolve({ ...row });
      }),
    },
  };
  const tenantPrisma = {
    requireCurrentSchema: () => 'tenant_acme_00000001',
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => Promise.resolve(cb(client)),
    forTenantTransaction: (_s: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const registry = {
    upsert: jest.fn((_args: unknown) => Promise.resolve({})),
    updateMany: jest.fn((_args: unknown) => Promise.resolve({ count: 1 })),
  };
  const controlPlane = {
    client: { paymentWebhookRegistry: registry },
  } as unknown as ControlPlanePrismaService;
  const requestContext = {
    get: () => ({ tenant: { id: TENANT_ID }, principal: null }),
  } as unknown as RequestContextService;
  const netpay = {
    checkCredentials: jest.fn(() => Promise.resolve('VALID' as const)),
  } as unknown as NetpayClient;
  const audit = { record: () => Promise.resolve() } as unknown as AuditLogService;
  const service = new PaymentConfigService(tenantPrisma, controlPlane, requestContext, box, netpay, audit);
  return { service, table, registry };
}

const KEYS = { publicKey: 'pk_netpay_one', secretKey: 'sk_netpay_one', environment: 'SANDBOX' as const };

describe('versioned payment configuration (BN-TASK-024)', () => {
  it('writes version 1, active, with MXN only and no return-origin allowlist', async () => {
    const f = fixture();
    const { config, webhookToken } = await f.service.save(KEYS);
    expect(config).toMatchObject({ version: 1, allowedCurrencies: ['MXN'], allowedReturnOrigins: [] });
    expect(webhookToken).toEqual(expect.any(String));
    expect(f.table).toHaveLength(1);
    expect(f.table[0]).toMatchObject({ version: 1, active: true });
  });

  it('appends a new version on change and keeps the old one, inactive, for its orders', async () => {
    const f = fixture();
    const first = await f.service.save(KEYS);
    const second = await f.service.save({ ...KEYS, environment: 'LIVE' });

    expect(f.table.map((r) => [r.version, r.active, r['environment']])).toEqual([
      [1, false, 'SANDBOX'],
      [2, true, 'LIVE'],
    ]);
    expect(second.config.id).not.toBe(first.config.id);
    // An order created on version 1 still reads version 1's credentials.
    const old = await f.service.getUsableInSchema('tenant_acme_00000001', first.config.id);
    expect(old).toMatchObject({ id: first.config.id, environment: 'SANDBOX', secretKey: 'sk_netpay_one' });
    const current = await f.service.getUsableInSchema('tenant_acme_00000001');
    expect(current).toMatchObject({ id: second.config.id, environment: 'LIVE' });
  });

  it('does not write a version when nothing changed', async () => {
    const f = fixture();
    await f.service.save(KEYS);
    const again = await f.service.save(KEYS);
    expect(f.table).toHaveLength(1);
    expect(again.webhookToken).toBeNull();
  });

  it.each([
    ['the environment', { environment: 'LIVE' as const }],
    ['the secret key', { secretKey: 'sk_netpay_two' }],
  ])(
    'issues a new webhook token and clears webhookRegisteredAt when %s changes (BN-REQ-CFG-003)',
    async (_l, change) => {
      const f = fixture();
      const first = await f.service.save(KEYS);
      f.table[0]['webhookRegisteredAt'] = new Date();
      const second = await f.service.save({ ...KEYS, ...change });

      expect(second.webhookToken).toEqual(expect.any(String));
      expect(second.webhookToken).not.toBe(first.webhookToken);
      expect(f.table[1]['webhookRegisteredAt']).toBeNull();
      expect(f.table[1]['webhookTokenHash']).toBe(PaymentSecretBox.hashToken(second.webhookToken as string));
      // The old token stops resolving: only the new one routes to this tenant.
      expect(f.registry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            tokenHash: { not: PaymentSecretBox.hashToken(second.webhookToken as string) },
          }) as unknown,
        }),
      );
    },
  );

  it('keeps the webhook token and its registration when only the public key changes', async () => {
    const f = fixture();
    await f.service.save(KEYS);
    const registeredAt = new Date('2026-10-01T00:00:00Z');
    f.table[0]['webhookRegisteredAt'] = registeredAt;
    const second = await f.service.save({ ...KEYS, publicKey: 'pk_netpay_two' });

    expect(second.webhookToken).toBeNull();
    expect(f.table[1]).toMatchObject({
      version: 2,
      webhookTokenHash: f.table[0]['webhookTokenHash'],
      webhookRegisteredAt: registeredAt,
    });
  });
});

describe('allowlists in the configuration (BN-TASK-021/022)', () => {
  it('stores return origins normalised, and currencies upper-case', async () => {
    const f = fixture();
    const { config } = await f.service.save({
      ...KEYS,
      allowedReturnOrigins: ['https://Shop.Example.com/', 'https://pay.example.com:8443'],
      allowedCurrencies: ['MXN', 'USD'],
    });
    expect(config.allowedReturnOrigins).toEqual(['https://shop.example.com', 'https://pay.example.com:8443']);
    expect(config.allowedCurrencies).toEqual(['MXN', 'USD']);
  });

  it('refuses an origin that is not https or carries a path', async () => {
    for (const origin of ['http://shop.example.com', 'https://shop.example.com/return', 'shop.example.com']) {
      const f = fixture();
      await expect(f.service.save({ ...KEYS, allowedReturnOrigins: [origin] })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('changes the allowlists alone as a new version that keeps the keys', async () => {
    const f = fixture();
    await f.service.save(KEYS);
    const { config } = await f.service.updateSettings({ allowedReturnOrigins: ['https://shop.example.com'] });
    expect(config).toMatchObject({ version: 2, allowedReturnOrigins: ['https://shop.example.com'] });
    expect(f.table[1]['secretKeyCiphertext']).toBe(f.table[0]['secretKeyCiphertext']);
    expect(f.table[1]['webhookTokenHash']).toBe(f.table[0]['webhookTokenHash']);
    expect(f.table.map((r) => r.active)).toEqual([false, true]);
  });
});
