import { describe, expect, it, jest } from '@jest/globals';
import { PaymentConfigService } from './payment-config.service';
import { PaymentSecretBox } from './payment-secret-box';
import type { NetpayClient } from './netpay.client';
import type { NetpayEnvironment } from './netpay-endpoints';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { AuditLogService } from '../audit/audit-log.service';

/**
 * BN-TASK-025: credentials are proven against the chosen Netpay environment before
 * anything is stored, so a live key saved as sandbox (or the reverse) is refused
 * with a code the operator can act on instead of failing at the first charge.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * @param accepts Environments in which Netpay accepts the key.
 * @returns The service and the spies that show what was written and asked.
 */
function fixture(accepts: readonly NetpayEnvironment[]) {
  const writes: unknown[] = [];
  const client = {
    paymentProviderConfig: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return Promise.resolve({
          id: 'cfg-1',
          tenantId: TENANT_ID,
          environment: args.data['environment'],
          publicKey: args.data['publicKey'],
          secretKeyCiphertext: 'x',
          orderReferencePrefix: 'acme',
          enabled: true,
        });
      }),
      update: jest.fn(),
      // Versioning deactivates the previous version (BN-TASK-024).
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
  const tenantPrisma = {
    requireCurrentSchema: () => 'tenant_acme_00000001',
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const controlPlane = {
    client: { paymentWebhookRegistry: { upsert: jest.fn(() => Promise.resolve({})) } },
  } as unknown as ControlPlanePrismaService;
  const requestContext = {
    get: () => ({ tenant: { id: TENANT_ID } }),
  } as unknown as RequestContextService;
  const checkCredentials = jest.fn((environment: NetpayEnvironment, _key: string) =>
    Promise.resolve(accepts.includes(environment) ? ('VALID' as const) : ('INVALID' as const)),
  );
  const netpay = { checkCredentials } as unknown as NetpayClient;
  const service = new PaymentConfigService(
    tenantPrisma,
    controlPlane,
    requestContext,
    new PaymentSecretBox(Buffer.alloc(32, 7).toString('base64')),
    netpay,
    { record: () => Promise.resolve() } as unknown as AuditLogService,
  );
  return { service, writes, checkCredentials };
}

const INPUT = { publicKey: 'pk_netpay_abc', secretKey: 'sk_netpay_abc123' }; // gitleaks:allow (fixture)

describe('PaymentConfigService credential check (BN-TASK-025)', () => {
  it('stores credentials Netpay accepts in the chosen environment', async () => {
    const f = fixture(['SANDBOX']);
    await f.service.save({ ...INPUT, environment: 'SANDBOX' });
    expect(f.checkCredentials).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_abc123');
    expect(f.writes).toHaveLength(1);
  });

  it('refuses a live key saved as SANDBOX with 422 CREDENTIALS_ENVIRONMENT_MISMATCH', async () => {
    const f = fixture(['LIVE']);
    await expect(f.service.save({ ...INPUT, environment: 'SANDBOX' })).rejects.toMatchObject({
      status: 422,
      code: 'CREDENTIALS_ENVIRONMENT_MISMATCH',
    });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a key no environment accepts with 422 CREDENTIALS_INVALID', async () => {
    const f = fixture([]);
    await expect(f.service.save({ ...INPUT, environment: 'LIVE' })).rejects.toMatchObject({
      status: 422,
      code: 'CREDENTIALS_INVALID',
    });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a malformed key before asking Netpay', async () => {
    const f = fixture(['SANDBOX']);
    await expect(
      f.service.save({ ...INPUT, secretKey: 'sk_netpay_abc-123', environment: 'SANDBOX' }), // gitleaks:allow (fixture)
    ).rejects.toMatchObject({ status: 400 });
    expect(f.checkCredentials).not.toHaveBeenCalled();
  });
});
