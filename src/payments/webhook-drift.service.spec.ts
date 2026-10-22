import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { PaymentSecretBox } from './payment-secret-box';
import { WebhookDriftService, compareWebhookUrl } from './webhook-drift.service';
import type { NetpayClient } from './netpay.client';
import type { PaymentConfigService } from './payment-config.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';

/**
 * Drift of the webhook registered at Netpay (BN-TASK-026, BN-REQ-CFG-004): the URL
 * Netpay calls must be `${PUBLIC_BASE_URL}/api/v1/payments/webhook/{token}` with
 * this tenant's current token.
 */

const BASE = 'https://netpay-api-staging-abc-ul.a.run.app';
const TOKEN = 'tok_current_0123456789';
const HASH = PaymentSecretBox.hashToken(TOKEN);
const SCHEMA = 'tenant_acme_00000001';

describe('compareWebhookUrl (BN-REQ-CFG-004)', () => {
  it.each([
    [`${BASE}/api/v1/payments/webhook/${TOKEN}`, false, 'match'],
    ['https://betydeliv.replit.app/api/v1/payments/webhook/' + TOKEN, true, 'origin'],
    [`${BASE}/api/v1/payments/webhook/tok_old_token_value`, true, 'token'],
    [`${BASE}/webhooks/netpay`, true, 'path'],
    [null, true, 'none_registered'],
    ['not a url', true, 'path'],
  ])('%s → drift %s (%s)', (registered, drift, reason) => {
    expect(compareWebhookUrl(registered, BASE, 'api/v1', HASH)).toEqual({ drift, reason });
  });

  it('compares the token alone when PUBLIC_BASE_URL is not configured', () => {
    expect(
      compareWebhookUrl(`https://elsewhere.example/api/v1/payments/webhook/${TOKEN}`, null, 'api/v1', HASH),
    ).toEqual({
      drift: false,
      reason: 'match',
    });
  });
});

function fixture(registered: unknown, tenants = [{ id: 't1', schemaName: SCHEMA }]) {
  const recorded: unknown[] = [];
  const getWebhook = jest.fn(() => Promise.resolve({ webhook: registered }));
  const netpay = { getWebhook } as unknown as NetpayClient;
  const config = {
    getUsableInSchema: () =>
      Promise.resolve({ id: 'cfg-1', environment: 'SANDBOX', secretKey: 'sk_netpay_x', tenantId: 't1' }),
    recordWebhookDrift: (_schema: string, configId: string, drift: boolean | null, at: Date) => {
      recorded.push({ configId, drift, at });
      return Promise.resolve();
    },
  } as unknown as PaymentConfigService;
  const state: Record<string, unknown> = {
    id: 'cfg-1',
    webhookTokenHash: HASH,
    webhookDrift: null,
    webhookDriftCheckedAt: null,
  };
  const tenantPrisma = {
    forTenantTransaction: (_s: string, cb: (c: unknown) => Promise<unknown>) =>
      cb({ paymentProviderConfig: { findFirst: () => Promise.resolve(state) } }),
  } as unknown as TenantPrismaService;
  const controlPlane = {
    client: { tenant: { findMany: jest.fn(() => Promise.resolve(tenants)) } },
  } as unknown as ControlPlanePrismaService;
  let now = 1_000_000;
  const service = new WebhookDriftService(config, netpay, tenantPrisma, controlPlane, {
    publicBaseUrl: BASE,
    apiPrefix: 'api/v1',
    checkIntervalMs: 3_600_000,
    summaryTtlMs: 60_000,
    now: () => now,
  });
  return { service, recorded, getWebhook, state, advance: (ms: number) => (now += ms) };
}

describe('WebhookDriftService (BN-TASK-026)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports drift when Netpay calls another deployment, records it and logs netpay_webhook_drift=1', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture(`https://betydeliv.replit.app/api/v1/payments/webhook/${TOKEN}`);

    const report = await f.service.check({ id: 't1', schemaName: SCHEMA });

    expect(report).toMatchObject({
      drift: true,
      reason: 'origin',
      registered: 'https://betydeliv.replit.app/api/v1/payments/webhook/[REDACTED]',
      expected: `${BASE}/api/v1/payments/webhook/{token}`,
    });
    expect(f.recorded).toEqual([expect.objectContaining({ configId: 'cfg-1', drift: true })]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'netpay_webhook_drift', drift: 1 }));
  });

  it('reports no drift for this deployment and the current token', async () => {
    const f = fixture(`${BASE}/api/v1/payments/webhook/${TOKEN}`);
    await expect(f.service.check({ id: 't1', schemaName: SCHEMA })).resolves.toMatchObject({
      drift: false,
      reason: 'match',
    });
  });

  it('checks a tenant against Netpay only when its last check is older than the interval', async () => {
    const f = fixture(`${BASE}/api/v1/payments/webhook/${TOKEN}`);
    f.state['webhookDriftCheckedAt'] = new Date(1_000_000 - 60_000);
    await f.service.checkIfDue({ id: 't1', schemaName: SCHEMA }, new Date(1_000_000));
    expect(f.getWebhook).not.toHaveBeenCalled();
    f.state['webhookDriftCheckedAt'] = new Date(1_000_000 - 2 * 3_600_000);
    await f.service.checkIfDue({ id: 't1', schemaName: SCHEMA }, new Date(1_000_000));
    expect(f.getWebhook).toHaveBeenCalledTimes(1);
  });

  it('summarises the stored verdicts for /health/ready without calling Netpay, and caches it', async () => {
    const f = fixture(null, [
      { id: 't1', schemaName: SCHEMA },
      { id: 't2', schemaName: 'tenant_globex_00000002' },
    ]);
    f.state['webhookDrift'] = true;
    f.state['webhookDriftCheckedAt'] = new Date(999_000);

    const summary = await f.service.summary();

    expect(summary).toMatchObject({
      status: 'drift',
      tenantsChecked: 2,
      tenantsDrifted: 2,
      tenantsUnchecked: 0,
    });
    expect(f.getWebhook).not.toHaveBeenCalled();
    f.state['webhookDrift'] = false;
    expect((await f.service.summary()).status).toBe('drift');
    f.advance(61_000);
    expect((await f.service.summary()).status).toBe('ok');
  });
});
