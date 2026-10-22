import { describe, expect, it, jest } from '@jest/globals';
import { PaymentConfigService } from './payment-config.service';
import { PaymentSecretBox } from './payment-secret-box';
import type { NetpayClient } from './netpay.client';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { AuditEntry, AuditLogService } from '../audit/audit-log.service';

/**
 * BN-TASK-030 / BN-REQ-OPS-011: every change to a tenant's payment configuration
 * is in the audit log, with the actor and what changed, and without a credential.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'sk_netpay_abc123'; // gitleaks:allow (fixture)
const box = new PaymentSecretBox(Buffer.alloc(32, 7).toString('base64'));

function fixture(existing: boolean) {
  const stored = {
    id: 'cfg-1',
    tenantId: TENANT_ID,
    environment: 'SANDBOX',
    publicKey: 'pk_netpay_old',
    secretKeyCiphertext: box.encrypt('sk_netpay_old', PaymentSecretBox.aadForConfig(TENANT_ID)),
    orderReferencePrefix: 'acme',
    enabled: true,
  };
  const client = {
    paymentProviderConfig: {
      findFirst: jest.fn(() => Promise.resolve(existing ? stored : null)),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...stored, ...args.data }),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...stored, ...args.data }),
      ),
      // Versioning deactivates the previous version (BN-TASK-024).
      updateMany: jest.fn(() => Promise.resolve({ count: existing ? 1 : 0 })),
    },
  };
  const tenantPrisma = {
    requireCurrentSchema: () => 'tenant_acme_00000001',
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => Promise.resolve(cb(client)),
    forTenantTransaction: (_s: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const controlPlane = {
    client: {
      paymentWebhookRegistry: {
        upsert: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      },
    },
  } as unknown as ControlPlanePrismaService;
  const requestContext = {
    get: () => ({
      tenant: { id: TENANT_ID },
      principal: {
        kind: 'tenant-user',
        id: 'owner-1',
        displayName: 'Owner',
        role: 'OWNER',
        tenantId: TENANT_ID,
      },
      ipHash: 'ip',
      userAgentHash: 'ua',
    }),
  } as unknown as RequestContextService;
  const netpay = {
    checkCredentials: jest.fn(() => Promise.resolve('VALID' as const)),
  } as unknown as NetpayClient;
  const audits: AuditEntry[] = [];
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;
  const service = new PaymentConfigService(tenantPrisma, controlPlane, requestContext, box, netpay, audit);
  return { service, audits };
}

describe('PaymentConfigService audit (BN-TASK-030)', () => {
  it('records a first configuration with the actor and the environment, never the secret', async () => {
    const f = fixture(false);
    const { webhookToken } = await f.service.save({
      publicKey: 'pk_netpay_abc',
      secretKey: SECRET,
      environment: 'SANDBOX',
    });
    expect(f.audits).toEqual([
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorType: 'TENANT_USER',
        actorId: 'owner-1',
        action: 'payment.config_created',
        resourceType: 'payment_config',
        metadata: expect.objectContaining({
          from: null,
          to: { environment: 'SANDBOX', publicKey: 'pk_netpay_abc' },
        }) as unknown,
      }),
    ]);
    const serialised = JSON.stringify(f.audits);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(webhookToken);
  });

  it('records a change of environment or keys as from → to', async () => {
    const f = fixture(true);
    await f.service.save({ publicKey: 'pk_netpay_new', secretKey: SECRET, environment: 'LIVE' });
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'payment.config_updated',
        resourceId: 'cfg-1',
        metadata: expect.objectContaining({
          from: { environment: 'SANDBOX', publicKey: 'pk_netpay_old', version: 1 },
          to: { environment: 'LIVE', publicKey: 'pk_netpay_new' },
          secretKeyChanged: true,
          webhookTokenReplaced: true,
        }) as unknown,
      }),
    ]);
    expect(JSON.stringify(f.audits)).not.toContain(SECRET);
  });

  it('records a webhook token rotation without the token', async () => {
    const f = fixture(true);
    const { token } = await f.service.rotateWebhookToken();
    expect(f.audits).toEqual([
      expect.objectContaining({ action: 'payment.webhook_token_rotated', resourceId: 'cfg-1' }),
    ]);
    expect(JSON.stringify(f.audits)).not.toContain(token);
  });

  it('records the registration of the inbound webhook URL by host', async () => {
    const f = fixture(true);
    await f.service.markWebhookRegistered(
      'cfg-1',
      'https://api.example.com/api/v1/payments/webhook/tok_secret',
    );
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'payment.webhook_registered',
        resourceId: 'cfg-1',
        metadata: { host: 'api.example.com' },
      }),
    ]);
  });
});
