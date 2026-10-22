import { jest } from '@jest/globals';
import { Prisma } from '../generated/tenant-plane/client';
import { PaymentOrdersService } from './payment-orders.service';
import { PAYMENT_EVENTS } from './payment-events';
import { NetpayRequestError, NetpayTransportError, type NetpayClient } from './netpay.client';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentEvents } from './payment-events';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { RecordEventInput } from './payment-events';
import type { AuditEntry, AuditLogService } from '../audit/audit-log.service';

/**
 * OXXO Pay cash references, hosted cash, and partial refunds. The tenant client
 * and Netpay are fakes; what is fixed here is what is sent to Netpay and what is
 * written back, never a network call.
 */

const SCHEMA = 'tenant_acme_00000001';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    sequence: 1,
    orderReference: 'acme_ref1',
    merchantReferenceCode: 'PLANE-1',
    amount: new Prisma.Decimal('100.00'),
    currency: 'MXN',
    status: 'PAID',
    netpayTransactionId: 'tx-1',
    amountToken: null,
    failureReason: null,
    checkoutMode: 'custom',
    paymentMethod: 'CARD',
    paymentReference: null,
    paymentReferenceExpiresAt: null,
    refundedAmount: new Prisma.Decimal('0'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function fixture(rows: Record<string, unknown>[]) {
  const writes: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const emitted: { type: string; status: string; previousStatus: string | null; refunded?: string }[] = [];
  const audits: AuditEntry[] = [];
  const client = {
    paymentOrder: {
      findFirst: jest.fn(() => Promise.resolve(rows[0] ?? null)),
      findFirstOrThrow: jest.fn(() =>
        Promise.resolve({ status: rows[0]?.['status'] ?? 'PENDING', sequence: 1 }),
      ),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        writes.push({ many: args.data });
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        const merged: Record<string, unknown> = { ...(rows[0] ?? {}) };
        for (const [k, v] of Object.entries(args.data)) {
          merged[k] =
            k === 'sequence' && typeof v === 'object' && v !== null
              ? Number(merged[k] ?? 0) + ((v as { increment?: number }).increment ?? 0)
              : v;
        }
        rows[0] = merged;
        return Promise.resolve(merged);
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        const made = row({
          ...args.data,
          id: 'order-new',
          status: 'PENDING',
          netpayTransactionId: null,
          paymentMethod: null,
          paymentReference: null,
          refundedAmount: new Prisma.Decimal('0'),
        });
        rows[0] = made;
        return Promise.resolve(made);
      }),
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
      principal: { kind: 'api-key', id: 'key-1', name: 'erp', tenantId: TENANT_ID, scopes: [] },
      ipHash: null,
      userAgentHash: null,
    }),
  } as unknown as RequestContextService;
  const cfg = {
    id: 'cfg-1',
    tenantId: TENANT_ID,
    environment: 'SANDBOX' as const,
    publicKey: 'pk_netpay_x',
    secretKey: 'sk_netpay_y',
    orderReferencePrefix: 'acme',
    enabled: true,
  };
  const config = {
    getUsable: () => Promise.resolve(cfg),
    getUsableInSchema: () => Promise.resolve(cfg),
  } as unknown as PaymentConfigService;
  const createOxxoReference = jest.fn((..._a: unknown[]) =>
    Promise.resolve({
      reference: '9201179201915626',
      oxxoPay: { expirationNumber: 2, expirationType: 'DAY', expirationDate: '2026-10-16T23:59:59' },
    } as Record<string, unknown>),
  );
  const createCheckoutSession = jest.fn((..._a: unknown[]) =>
    Promise.resolve({ sessionId: 'sess_1', hostedCheckoutUrl: 'https://pay.example/h/sess_1' }),
  );
  const refund = jest.fn((..._a: unknown[]) => Promise.resolve());
  const cancelCharge = jest.fn((..._a: unknown[]) => Promise.resolve('CANCELED' as string | null));
  const netpay = {
    createOxxoReference,
    createCheckoutSession,
    refund,
    cancelCharge,
  } as unknown as NetpayClient;
  // The outbox writer, called with the transaction client that changed the order.
  const events = {
    record: (_tx: unknown, input: RecordEventInput) => {
      emitted.push({
        type: input.eventType,
        status: input.order.status,
        previousStatus: input.previousStatus,
        ...(input.refunded === undefined ? {} : { refunded: input.refunded.toFixed(2) }),
      });
      return Promise.resolve({});
    },
  } as unknown as PaymentEvents;
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;
  return {
    service: new PaymentOrdersService(tenantPrisma, requestContext, config, netpay, events, audit),
    writes,
    created,
    emitted,
    audits,
    createOxxoReference,
    createCheckoutSession,
    refund,
    cancelCharge,
    rows,
  };
}

describe('OXXO Pay cash reference (checkoutMode oxxo)', () => {
  it('creates the reference with the order reference as merchant reference and strips accents from the buyer', async () => {
    const f = fixture([]);
    const view = await f.service.create({
      merchantReferenceCode: 'PLANE-9',
      amount: '120.00',
      checkoutMode: 'oxxo',
      buyer: { name: 'Rosa Díaz', email: 'rosa@example.mx', phone: '6674922953' },
    });
    expect(f.createOxxoReference).toHaveBeenCalledTimes(1);
    const body = f.createOxxoReference.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body['name']).toBe('Rosa Diaz');
    expect(body['amount']).toBe('120.00');
    expect(body['merchantReferenceCode']).toBe(f.created[0]?.['orderReference']);
    expect(body['oxxoPay']).toEqual({ expirationNumber: '2', expirationType: 'DAY' });
    expect(view.paymentMethod).toBe('OXXO');
    expect(view.paymentReference).toBe('9201179201915626');
    // 2026-10-16 23:59:59 in Mexico City is 05:59:59 the next day in UTC.
    expect(view.paymentReferenceExpiresAt).toBe('2026-10-17T05:59:59.000Z');
  });

  it('refuses a cash order without a buyer, before calling Netpay', async () => {
    const f = fixture([]);
    await expect(
      f.service.create({ merchantReferenceCode: 'X', amount: '10.00', checkoutMode: 'oxxo' }),
    ).rejects.toThrow(/buyer/i);
    expect(f.createOxxoReference).not.toHaveBeenCalled();
  });

  it('keeps the order but marks the failure when Netpay refuses the reference', async () => {
    const f = fixture([]);
    f.createOxxoReference.mockRejectedValueOnce(new Error('This payment method is inactive'));
    await expect(
      f.service.create({
        merchantReferenceCode: 'X',
        amount: '10.00',
        checkoutMode: 'oxxo',
        buyer: { name: 'A', email: 'a@b.mx' },
      }),
    ).rejects.toThrow(/inactive/);
    expect(f.writes.some((w) => w['failureReason'] === 'Checkout session could not be created.')).toBe(true);
  });
});

describe('Hosted session methods', () => {
  it('offers card and cash on the hosted page when asked', async () => {
    const f = fixture([]);
    await f.service.create({
      merchantReferenceCode: 'H',
      amount: '50.00',
      checkoutMode: 'hosted',
      paymentMethods: ['card', 'cep'],
    });
    const body = f.createCheckoutSession.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body['paymentMethodTypes']).toEqual(['card', 'cep']);
  });

  it('defaults to card only', async () => {
    const f = fixture([]);
    await f.service.create({ merchantReferenceCode: 'H', amount: '50.00', checkoutMode: 'hosted' });
    const body = f.createCheckoutSession.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body['paymentMethodTypes']).toEqual(['card']);
  });
});

describe('Partial refunds', () => {
  it('returns part of the amount: PARTIALLY_REFUNDED, accumulates, and announces payment.refunded', async () => {
    const f = fixture([row()]);
    const result = await f.service.refund('order-1', 'cliente', '30.00');
    expect(f.refund).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1', '30.00', 'cliente');
    expect(result).toEqual({ status: 'PARTIALLY_REFUNDED', refundedAmount: '30.00', refunded: '30.00' });
    expect(f.emitted).toEqual([
      {
        type: PAYMENT_EVENTS.REFUNDED,
        status: 'PARTIALLY_REFUNDED',
        previousStatus: 'PAID',
        refunded: '30.00',
      },
    ]);
  });

  it('turns REFUNDED only when the total reaches the amount (BN-REQ-PAY-005)', async () => {
    const f = fixture([row({ status: 'PARTIALLY_REFUNDED', refundedAmount: new Prisma.Decimal('30.00') })]);
    const result = await f.service.refund('order-1', 'resto');
    // Not an untouched charge, so the refund service is the only route.
    expect(f.cancelCharge).not.toHaveBeenCalled();
    expect(f.refund).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1', '70.00', 'resto');
    expect(result).toEqual({ status: 'REFUNDED', refundedAmount: '100.00', refunded: '70.00' });
    expect(f.emitted).toEqual([
      {
        type: PAYMENT_EVENTS.REFUNDED,
        status: 'REFUNDED',
        previousStatus: 'PARTIALLY_REFUNDED',
        refunded: '70.00',
      },
    ]);
  });

  it('announces a second partial refund too, although the status stays PARTIALLY_REFUNDED', async () => {
    const f = fixture([row({ status: 'PARTIALLY_REFUNDED', refundedAmount: new Prisma.Decimal('30.00') })]);
    const result = await f.service.refund('order-1', 'otra', '20.00');
    expect(result).toEqual({ status: 'PARTIALLY_REFUNDED', refundedAmount: '50.00', refunded: '20.00' });
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({ type: PAYMENT_EVENTS.REFUNDED, refunded: '20.00' });
  });

  it('still refunds the rest of an order partly refunded before PARTIALLY_REFUNDED existed (left PAID)', async () => {
    const f = fixture([row({ refundedAmount: new Prisma.Decimal('30.00') })]);
    const result = await f.service.refund('order-1', 'resto');
    expect(result.status).toBe('REFUNDED');
  });

  it('refuses to refund a fully refunded order', async () => {
    const f = fixture([row({ status: 'REFUNDED', refundedAmount: new Prisma.Decimal('100.00') })]);
    await expect(f.service.refund('order-1', 'x', '1.00')).rejects.toThrow(/REFUNDED/);
    expect(f.refund).not.toHaveBeenCalled();
  });

  it('refuses a refund above what is left, without calling Netpay', async () => {
    const f = fixture([row({ refundedAmount: new Prisma.Decimal('80.00') })]);
    await expect(f.service.refund('order-1', 'x', '30.00')).rejects.toThrow(/20\.00 of 100\.00 is left/);
    expect(f.refund).not.toHaveBeenCalled();
  });

  it('rejects malformed or non-positive amounts', async () => {
    const f = fixture([row()]);
    await expect(f.service.refund('order-1', 'x', '0')).rejects.toThrow(/positive/);
    await expect(f.service.refund('order-1', 'x', '1.234')).rejects.toThrow(/positive/);
    expect(f.refund).not.toHaveBeenCalled();
  });

  it('keeps the order untouched when Netpay refuses the reversal', async () => {
    const f = fixture([row()]);
    f.refund.mockRejectedValueOnce(new Error('Comercio no tiene permitida esta operativa'));
    await expect(f.service.refund('order-1', 'x', '10.00')).rejects.toThrow(/permitida/);
    expect(f.writes.some((w) => 'refundedAmount' in w)).toBe(false);
    expect(f.emitted).toHaveLength(0);
  });
});

describe('attachCashReferenceInSchema', () => {
  it('only fills an empty reference on an unsettled order', async () => {
    const f = fixture([row({ status: 'PENDING' })]);
    await f.service.attachCashReferenceInSchema(SCHEMA, 'order-1', '1258630012130904229', null);
    expect(f.writes[0]).toMatchObject({
      many: { paymentMethod: 'OXXO', paymentReference: '1258630012130904229' },
    });
  });
});

describe('Full refund through the gateway cancellation', () => {
  it('cancels an untouched charge through the gateway and never calls the refund service', async () => {
    const f = fixture([row()]);
    const result = await f.service.refund('order-1', 'cliente');
    expect(f.cancelCharge).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1');
    expect(f.refund).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'REFUNDED', refundedAmount: '100.00', refunded: '100.00' });
  });

  it('never uses the gateway for a partial amount, which would cancel the whole charge', async () => {
    const f = fixture([row()]);
    await f.service.refund('order-1', 'parcial', '40.00');
    expect(f.cancelCharge).not.toHaveBeenCalled();
    expect(f.refund).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1', '40.00', 'parcial');
  });

  it('falls back to the refund service when Netpay refuses the cancellation (cut-off passed)', async () => {
    const f = fixture([row()]);
    f.cancelCharge.mockRejectedValueOnce(new NetpayRequestError(400, '/v3/transactions/tx-1/refund', null));
    const result = await f.service.refund('order-1', 'tarde');
    expect(f.refund).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1', '100.00', 'tarde');
    expect(result.status).toBe('REFUNDED');
  });

  it('falls back when the gateway answers something other than CANCELED', async () => {
    const f = fixture([row()]);
    f.cancelCharge.mockResolvedValueOnce('DONE');
    await f.service.refund('order-1', 'x');
    expect(f.refund).toHaveBeenCalledTimes(1);
  });

  it('does NOT try the other route after a transport failure: the cancellation may have been carried out', async () => {
    const f = fixture([row()]);
    f.cancelCharge.mockRejectedValueOnce(
      new NetpayTransportError('/v3/transactions/tx-1/refund', new Error('timeout')),
    );
    await expect(f.service.refund('order-1', 'x')).rejects.toThrow(/could not be reached/);
    expect(f.refund).not.toHaveBeenCalled();
    expect(f.writes.some((w) => 'refundedAmount' in w)).toBe(false);
  });

  it('does NOT try the other route after a 5xx: it is an unknown outcome, not a refusal', async () => {
    const f = fixture([row()]);
    f.cancelCharge.mockRejectedValueOnce(new NetpayRequestError(500, '/v3/transactions/tx-1/refund', 'boom'));
    await expect(f.service.refund('order-1', 'x')).rejects.toThrow(/no definitive answer \(status 500\)/);
    expect(f.refund).not.toHaveBeenCalled();
    // The order is left refundable so the caller can retry.
    expect(f.writes.some((w) => 'refundedAmount' in w)).toBe(false);
  });
});

describe('Refund claim when the provider outcome is unknown (BN-TASK-013)', () => {
  /** Whether a write cleared the operation claim. */
  const released = (writes: Record<string, unknown>[]) =>
    writes.some((w) => {
      const data = (w['many'] ?? w) as Record<string, unknown>;
      return 'operationClaim' in data && data['operationClaim'] === null;
    });

  it('keeps the claim after a Netpay timeout, so a retry cannot reverse twice', async () => {
    const f = fixture([row()]);
    f.cancelCharge.mockRejectedValueOnce(
      new NetpayTransportError('/v3/transactions/tx-1/refund', new Error('timeout')),
    );
    const error = await f.service.refund('order-1', 'x').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', status: 504, retryable: true });
    expect(released(f.writes)).toBe(false);
  });

  it('keeps the claim after a Netpay 5xx', async () => {
    const f = fixture([row()]);
    f.cancelCharge.mockRejectedValueOnce(new NetpayRequestError(503, '/v3/transactions/tx-1/refund', null));
    await expect(f.service.refund('order-1', 'x')).rejects.toMatchObject({
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    expect(released(f.writes)).toBe(false);
  });

  it('releases the claim after an explicit refusal, so the caller can retry', async () => {
    const f = fixture([row()]);
    f.refund.mockRejectedValueOnce(new NetpayRequestError(400, '/v2/transactions/x/refund', 'No permitida'));
    await expect(f.service.refund('order-1', 'x', '10.00')).rejects.toMatchObject({
      code: 'PROVIDER_DECLINED',
      status: 502,
    });
    expect(released(f.writes)).toBe(true);
  });
});

describe('Audit of payment status changes (BN-TASK-030, BN-REQ-OPS-011)', () => {
  it('records the change with the actor, the tenant, the order and from → to', async () => {
    const f = fixture([row()]);
    await f.service.refund('order-1', 'cliente', '30.00');
    expect(f.audits).toEqual([
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorType: 'API_KEY',
        actorId: 'key-1',
        actorLabel: 'erp',
        action: 'payment.status_changed',
        resourceType: 'payment_order',
        resourceId: 'order-1',
        metadata: expect.objectContaining({
          orderId: 'order-1',
          from: 'PAID',
          to: 'PARTIALLY_REFUNDED',
          event: PAYMENT_EVENTS.REFUNDED,
        }) as unknown,
      }),
    ]);
  });

  it('records nothing when the provider refused and nothing changed', async () => {
    const f = fixture([row()]);
    f.refund.mockRejectedValueOnce(new Error('Comercio no tiene permitida esta operativa'));
    await expect(f.service.refund('order-1', 'x', '10.00')).rejects.toThrow(/permitida/);
    expect(f.audits).toHaveLength(0);
  });

  it('records the creation of an order as ∅ → PENDING', async () => {
    const f = fixture([]);
    await f.service.create({ merchantReferenceCode: 'H', amount: '50.00', checkoutMode: 'custom' });
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'payment.status_changed',
        metadata: expect.objectContaining({ from: null, to: 'PENDING' }) as unknown,
      }),
    ]);
  });
});
