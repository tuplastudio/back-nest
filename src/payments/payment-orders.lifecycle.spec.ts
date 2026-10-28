import { describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/tenant-plane/client';
import { PaymentOrdersService, decodeOrderCursor, encodeOrderCursor } from './payment-orders.service';
import type { NetpayClient } from './netpay.client';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentEvents, RecordEventInput } from './payment-events';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { AuditEntry, AuditLogService } from '../audit/audit-log.service';
import type { PaymentQuickLinksService } from './payment-quick-links.service';

const quickLinks = {
  enabled: () => false,
  newCode: () => 'ABCDEF',
  returnUrls: () => ({ successUrl: '', cancelUrl: '' }),
  register: () => Promise.resolve({ code: 'ABCDEF', url: '' }),
  findForOrder: () => Promise.resolve(null),
  findForOrders: () => Promise.resolve(new Map()),
} as unknown as PaymentQuickLinksService;

/**
 * Order lifecycle added in the last wave:
 *
 *  * BN-TASK-017 — cursor listing with filters, and the verified fields on GET;
 *  * BN-TASK-018 — cancellation of unpaid orders, and a late payment on a
 *    cancelled order recorded without reopening it;
 *  * BN-TASK-021 — hosted return URLs only https and within the tenant allowlist;
 *  * BN-TASK-022 — only the currencies the tenant is enabled for.
 */

const SCHEMA = 'tenant_acme_00000001';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function order(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    sequence: 0,
    orderReference: 'acme_abc',
    merchantReferenceCode: 'REF-1',
    amount: new Prisma.Decimal('100.00'),
    currency: 'MXN',
    status: 'PENDING',
    netpayTransactionId: null,
    amountToken: null,
    failureReason: null,
    failureCode: null,
    checkoutMode: 'hosted',
    paymentMethod: null,
    paymentReference: null,
    paymentReferenceExpiresAt: null,
    refundedAmount: new Prisma.Decimal('0'),
    verifiedAmount: null,
    paidAfterCancelAt: null,
    configId: 'cfg-1',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

function fixture(
  options: {
    rows?: Record<string, unknown>[];
    transaction?: Record<string, unknown>;
    config?: Record<string, unknown>;
    attempts?: Record<string, unknown>[];
  } = {},
) {
  const rows = options.rows ?? [order()];
  const emitted: string[] = [];
  const audits: AuditEntry[] = [];
  const claims: Record<string, unknown>[] = [];
  const findMany = jest.fn((_args: Record<string, unknown>) => Promise.resolve(rows));
  const client = {
    paymentOrder: {
      findFirst: jest.fn(() => Promise.resolve(rows[0] ?? null)),
      findFirstOrThrow: jest.fn(() => Promise.resolve(rows[0])),
      findMany,
      updateMany: jest.fn((args: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => {
        claims.push({ ...(args.where ?? {}), data: args.data });
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn((args: { data: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const merged: Record<string, unknown> = { ...rows[0] };
        for (const [key, value] of Object.entries(args.data)) {
          if (typeof value === 'object' && value !== null && 'increment' in value) {
            merged[key] = Number(merged[key] ?? 0) + Number((value as { increment: number }).increment);
          } else {
            merged[key] = value;
          }
        }
        rows[0] = merged;
        return Promise.resolve(merged);
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(order({ ...args.data, id: 'order-new' })),
      ),
    },
    paymentAttempt: {
      findMany: jest.fn(() => Promise.resolve(options.attempts ?? [])),
      findFirst: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      create: jest.fn(() => Promise.resolve({})),
    },
  };
  const tenantPrisma = {
    requireCurrentSchema: () => SCHEMA,
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => Promise.resolve(cb(client)),
    forTenantTransaction: (_s: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const requestContext = {
    get: () => ({
      tenant: { id: TENANT_ID, schemaName: SCHEMA },
      principal: { kind: 'api-key', id: 'k1', name: 'k' },
    }),
  } as unknown as RequestContextService;
  const configValue = {
    id: 'cfg-1',
    tenantId: TENANT_ID,
    environment: 'SANDBOX' as const,
    publicKey: 'pk_netpay_x',
    secretKey: 'sk_netpay_y',
    orderReferencePrefix: 'acme',
    enabled: true,
    version: 1,
    allowedReturnOrigins: [] as string[],
    allowedCurrencies: ['MXN'],
    ...options.config,
  };
  const configCalls: unknown[] = [];
  const config = {
    getUsable: (configId?: string | null) => {
      configCalls.push(configId);
      return Promise.resolve(configValue);
    },
    getUsableInSchema: (_s: string, configId?: string | null) => {
      configCalls.push(configId);
      return Promise.resolve(configValue);
    },
  } as unknown as PaymentConfigService;
  const createCheckoutSession = jest.fn((_e: string, _k: string, _b: Record<string, unknown>) =>
    Promise.resolve({ sessionId: 'sess_1', hostedCheckoutUrl: 'https://pay.example/s/1' }),
  );
  const netpay = {
    getTransaction: jest.fn(() => Promise.resolve(options.transaction ?? { status: 'DONE', amount: 100 })),
    createCheckoutSession,
  } as unknown as NetpayClient;
  const events = {
    record: (_tx: unknown, input: RecordEventInput) => {
      emitted.push(input.eventType);
      return Promise.resolve({});
    },
  } as unknown as PaymentEvents;
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;
  const service = new PaymentOrdersService(
    tenantPrisma,
    requestContext,
    config,
    netpay,
    events,
    audit,
    quickLinks,
  );
  return { service, rows, emitted, audits, claims, findMany, configCalls, createCheckoutSession };
}

describe('GET /t/payments/orders with a cursor (BN-TASK-017)', () => {
  it('round-trips an opaque cursor and refuses a forged one', () => {
    const cursor = encodeOrderCursor({
      direction: 'asc',
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      id: 'o1',
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeOrderCursor(cursor)).toEqual({
      direction: 'asc',
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      id: 'o1',
    });
    for (const bad of ['nope', Buffer.from('{"d":"x"}').toString('base64url'), '']) {
      expect(() => decodeOrderCursor(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
  });

  it('pages oldest-update first from updatedSince, with the filters, and hands back a cursor', async () => {
    const rows = [order({ id: 'a' }), order({ id: 'b' }), order({ id: 'c' })];
    const f = fixture({ rows });
    const since = new Date('2026-09-01T00:00:00Z');

    const page = await f.service.list({
      limit: 2,
      updatedSince: since,
      status: ['PAID', 'REFUNDED'],
      merchantReferenceCode: 'REF-1',
    });

    const args = f.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
      orderBy: unknown;
    };
    expect(args.take).toBe(3);
    expect(args.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
    expect(args.where).toMatchObject({
      updatedAt: { gte: since },
      status: { in: ['PAID', 'REFUNDED'] },
      merchantReferenceCode: 'REF-1',
    });
    expect(page.items.map((o) => o.id)).toEqual(['a', 'b']);
    expect(decodeOrderCursor(page.nextCursor as string)).toMatchObject({ direction: 'asc', id: 'b' });
  });

  it('continues after the cursor and says when there is nothing more', async () => {
    const f = fixture({ rows: [order({ id: 'c' })] });
    const cursor = encodeOrderCursor({
      direction: 'asc',
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      id: 'b',
    });

    const page = await f.service.list({ limit: 2, cursor });

    const args = f.findMany.mock.calls[0][0] as { where: { AND: unknown[] } };
    expect(JSON.stringify(args.where)).toContain('"id":{"gt":"b"}');
    expect(page.nextCursor).toBeNull();
  });

  it('lists newest first without updatedSince, and refuses an unknown status', async () => {
    const f = fixture();
    await f.service.list({});
    const args = f.findMany.mock.calls[0][0] as { orderBy: unknown; take: number };
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(26);
    await expect(f.service.list({ status: ['PAYED'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reads one order with verifiedAmount, the transaction, refunds, failure code and its attempts', async () => {
    const f = fixture({
      rows: [
        order({
          status: 'PAID',
          netpayTransactionId: 'txn-2',
          verifiedAmount: new Prisma.Decimal('100'),
          refundedAmount: new Prisma.Decimal('0'),
        }),
      ],
      attempts: [
        {
          attemptNo: 1,
          status: 'FAILED',
          declineCode: 'INSUFFICIENT_FUNDS',
          netpayTransactionId: 'txn-1',
          createdAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          attemptNo: 2,
          status: 'PAID',
          declineCode: null,
          netpayTransactionId: 'txn-2',
          createdAt: new Date('2026-10-01T00:01:00Z'),
        },
      ],
    });

    const view = await f.service.findById('order-1');

    expect(view).toMatchObject({
      verifiedAmount: '100.00',
      netpayTransactionId: 'txn-2',
      refundedAmount: '0.00',
      failureCode: null,
      paidAfterCancelAt: null,
      attempts: {
        count: 2,
        items: [
          { attemptNo: 1, status: 'FAILED', declineCode: 'INSUFFICIENT_FUNDS', netpayTransactionId: 'txn-1' },
          { attemptNo: 2, status: 'PAID', declineCode: null, netpayTransactionId: 'txn-2' },
        ],
      },
    });
  });
});

describe('POST /t/payments/orders/:id/cancel (BN-TASK-018)', () => {
  it('cancels an unpaid order, under a claim, and emits payment.cancelled', async () => {
    const f = fixture();
    const view = await f.service.cancel('order-1');
    expect(view.status).toBe('CANCELLED');
    expect(f.emitted).toEqual(['payment.cancelled']);
    expect(f.claims[0]).toMatchObject({ data: { operationClaim: 'cancel' } });
  });

  it('cancels a FAILED order', async () => {
    const f = fixture({ rows: [order({ status: 'FAILED', netpayTransactionId: 'txn-1' })] });
    expect((await f.service.cancel('order-1')).status).toBe('CANCELLED');
  });

  it('answers an already cancelled order as it is, emitting nothing', async () => {
    const f = fixture({ rows: [order({ status: 'CANCELLED' })] });
    expect((await f.service.cancel('order-1')).status).toBe('CANCELLED');
    expect(f.emitted).toEqual([]);
  });

  it.each(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED', 'AMOUNT_MISMATCH', 'CHARGE_UNKNOWN'])(
    'refuses a %s order with 409 ORDER_STATE_CONFLICT',
    async (status) => {
      const f = fixture({ rows: [order({ status })] });
      await expect(f.service.cancel('order-1')).rejects.toMatchObject({
        status: 409,
        code: 'ORDER_STATE_CONFLICT',
      });
      expect(f.emitted).toEqual([]);
    },
  );

  it('asks Netpay first when a charge is bound, and refuses with the PAID order when it was charged', async () => {
    const f = fixture({
      rows: [order({ status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1', checkoutMode: 'custom' })],
      transaction: { status: 'DONE', amount: 100 },
    });
    await expect(f.service.cancel('order-1')).rejects.toMatchObject({
      code: 'ORDER_STATE_CONFLICT',
      details: expect.objectContaining({ status: 'PAID' }) as unknown,
    });
    expect(f.emitted).toEqual(['payment.paid']);
  });

  it('cancels a charge abandoned in 3-D Secure', async () => {
    const f = fixture({
      rows: [order({ status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1', checkoutMode: 'custom' })],
      transaction: { status: 'WAIT_THREEDS', amount: 100 },
    });
    expect((await f.service.cancel('order-1')).status).toBe('CANCELLED');
  });

  it('uses the configuration the order was created with (BN-REQ-CFG-002)', async () => {
    const f = fixture({
      rows: [order({ status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1', configId: 'cfg-old' })],
      transaction: { status: 'WAIT_THREEDS', amount: 100 },
    });
    await f.service.cancel('order-1');
    expect(f.configCalls).toContain('cfg-old');
  });

  it('records a payment Netpay reports later without reopening the order, and audits it', async () => {
    const f = fixture({
      rows: [order({ status: 'CANCELLED', netpayTransactionId: null })],
      transaction: { status: 'DONE', amount: 100, merchantReferenceCode: 'acme_abc' },
    });

    const result = await f.service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-late', TENANT_ID);

    expect(result.status).toBe('CANCELLED');
    expect(f.rows[0]).toMatchObject({ status: 'CANCELLED', netpayTransactionId: 'txn-late' });
    expect(f.rows[0]['paidAfterCancelAt']).toBeInstanceOf(Date);
    expect(f.emitted).toEqual(['payment.paid_after_cancel']);
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'payment.paid_after_cancel',
        metadata: expect.objectContaining({
          outcome: 'LATE_PAYMENT_ON_CANCELLED',
          status: 'CANCELLED',
        }) as unknown,
      }),
    ]);
  });

  it('does not move a cancelled order when Netpay reports a decline', async () => {
    const f = fixture({
      rows: [order({ status: 'CANCELLED', netpayTransactionId: 'txn-1' })],
      transaction: { status: 'REJECT', amount: 100 },
    });
    const result = await f.service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result).toMatchObject({ status: 'CANCELLED', changed: false });
    expect(f.emitted).toEqual([]);
  });
});

describe('hosted return URLs (BN-TASK-021)', () => {
  const hosted = { merchantReferenceCode: 'R-1', amount: '100.00', checkoutMode: 'hosted' as const };

  it('refuses a return URL that is not https with 422 RETURN_URL_NOT_ALLOWED', async () => {
    const f = fixture();
    await expect(
      f.service.create({ ...hosted, successUrl: 'http://shop.example.com/ok' }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'RETURN_URL_NOT_ALLOWED',
    });
    expect(f.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses an origin outside the tenant allowlist once one is configured', async () => {
    const f = fixture({ config: { allowedReturnOrigins: ['https://shop.example.com'] } });
    await expect(
      f.service.create({ ...hosted, cancelUrl: 'https://evil.example/phish' }),
    ).rejects.toMatchObject({ status: 422, code: 'RETURN_URL_NOT_ALLOWED' });
    await expect(
      f.service.create({ ...hosted, successUrl: 'https://shop.example.com/thanks?o=1' }),
    ).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('accepts any https origin while the allowlist is empty, and warns', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture();
    await expect(
      f.service.create({ ...hosted, successUrl: 'https://anywhere.example/ok' }),
    ).resolves.toMatchObject({ status: 'PENDING' });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'return_url_origin_unrestricted' }));
    warn.mockRestore();
  });
});

describe('currencies (BN-TASK-022)', () => {
  it('refuses a currency the tenant is not enabled for with 422 CURRENCY_NOT_ENABLED', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        merchantReferenceCode: 'R-1',
        amount: '10.00',
        currency: 'USD',
        checkoutMode: 'custom',
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'USD', allowed: ['MXN'] },
    });
  });

  it('accepts it once the tenant is enabled for it', async () => {
    const f = fixture({ config: { allowedCurrencies: ['MXN', 'USD'] } });
    await expect(
      f.service.create({
        merchantReferenceCode: 'R-1',
        amount: '10.00',
        currency: 'USD',
        checkoutMode: 'custom',
      }),
    ).resolves.toMatchObject({ currency: 'USD' });
  });
});

describe('reconcileOrder (BN-TASK-016)', () => {
  const NOW = new Date('2026-10-21T12:00:00Z');
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const tenant = { id: TENANT_ID, schemaName: SCHEMA };

  async function reconcile(row: Record<string, unknown>, transaction?: Record<string, unknown>) {
    const f = fixture({
      rows: [order({ pendingProviderResults: [], operationClaim: null, ...row })],
      transaction,
    });
    const calls: string[] = [];
    const outcome = await f.service.reconcileOrder(tenant, 'order-1', {
      now: NOW,
      beforeProviderCall: () => {
        calls.push('netpay');
        return Promise.resolve();
      },
      threeDsTimeoutMs: 30 * 60_000,
      chargeUnknownGraceMs: 60 * 60_000,
      referenceGraceMs: 5 * 60_000,
    });
    return { outcome, f, calls };
  }

  it('settles a PENDING order Netpay reports paid, rate-limited', async () => {
    const { outcome, f, calls } = await reconcile(
      { netpayTransactionId: 'txn-1', updatedAt: ago(10) },
      { status: 'DONE', amount: 100 },
    );
    expect(outcome).toMatchObject({ from: 'PENDING', to: 'PAID', corrected: true, action: 'verified' });
    expect(f.emitted).toEqual(['payment.paid']);
    expect(calls).toEqual(['netpay']);
  });

  it('records a decline as FAILED', async () => {
    const { outcome } = await reconcile(
      { status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1' },
      { status: 'REJECT', amount: 100 },
    );
    expect(outcome).toMatchObject({ to: 'FAILED', corrected: true });
  });

  it('expires a 3-D Secure challenge left more than 30 min, and keeps a younger one', async () => {
    const old = await reconcile(
      { status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1', updatedAt: ago(45) },
      { status: 'WAIT_THREEDS', amount: 100 },
    );
    expect(old.outcome).toMatchObject({ to: 'EXPIRED', action: 'expired' });
    expect(old.f.emitted).toEqual(['payment.expired']);
    const young = await reconcile(
      { status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1', updatedAt: ago(10) },
      { status: 'WAIT_THREEDS', amount: 100 },
    );
    expect(young.outcome).toMatchObject({ to: 'PENDING_VERIFICATION', corrected: false });
    expect(young.f.emitted).toEqual([]);
  });

  it('expires an unpaid cash reference past its expiry without asking Netpay', async () => {
    const { outcome, calls } = await reconcile({
      checkoutMode: 'oxxo',
      paymentReference: '9201',
      paymentReferenceExpiresAt: ago(30),
    });
    expect(outcome).toMatchObject({ to: 'EXPIRED' });
    expect(calls).toEqual([]);
  });

  it('returns CHARGE_UNKNOWN to PENDING after the grace period only', async () => {
    const old = await reconcile({ status: 'CHARGE_UNKNOWN', updatedAt: ago(90) });
    expect(old.outcome).toMatchObject({ to: 'PENDING', action: 'charge_unknown_reset' });
    expect(old.f.rows[0]).toMatchObject({ netpayTransactionId: null, operationClaim: null });
    const young = await reconcile({ status: 'CHARGE_UNKNOWN', updatedAt: ago(10) });
    expect(young.outcome).toMatchObject({ to: 'CHARGE_UNKNOWN', corrected: false });
  });

  it('completes a refund of unknown outcome when Netpay reports the charge cancelled', async () => {
    const { outcome, f } = await reconcile(
      { status: 'PAID', netpayTransactionId: 'txn-1', operationClaim: 'refund' },
      { status: 'CANCELED', amount: 100 },
    );
    expect(outcome).toMatchObject({ to: 'REFUNDED', action: 'refund_completed', corrected: true });
    expect(f.emitted).toEqual(['payment.refunded']);
  });

  it('leaves a refund of unknown outcome for an operator while Netpay still reports the charge', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { outcome } = await reconcile(
      { status: 'PAID', netpayTransactionId: 'txn-1', operationClaim: 'refund' },
      { status: 'DONE', amount: 100 },
    );
    expect(outcome).toMatchObject({ to: 'PAID', action: 'manual_review', corrected: false });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'reconcile_manual_review' }));
    warn.mockRestore();
  });

  it('records a late payment on a cancelled order', async () => {
    const { outcome, f } = await reconcile(
      { status: 'CANCELLED', netpayTransactionId: 'txn-1' },
      { status: 'DONE', amount: 100 },
    );
    expect(outcome).toMatchObject({
      from: 'CANCELLED',
      to: 'CANCELLED',
      corrected: true,
      action: 'paid_after_cancel',
    });
    expect(f.emitted).toEqual(['payment.paid_after_cancel']);
  });

  it('skips an order whose provider result waits to be applied, and a settled order', async () => {
    const pending = await reconcile({ netpayTransactionId: 'txn-1', pendingProviderResults: [{ id: 'p1' }] });
    expect(pending.outcome.action).toBe('skipped');
    const paid = await reconcile({ status: 'PAID', netpayTransactionId: 'txn-1' });
    expect(paid.outcome).toMatchObject({ action: 'unchanged', corrected: false });
    expect(paid.calls).toEqual([]);
  });
});
