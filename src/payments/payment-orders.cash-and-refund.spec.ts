import { jest } from '@jest/globals';
import { Prisma } from '../generated/tenant-plane/client';
import { PaymentOrdersService } from './payment-orders.service';
import { PAYMENT_EVENTS } from './payment-events';
import { NetpayRequestError, NetpayTransportError, type NetpayClient } from './netpay.client';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentEvents } from './payment-events';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';

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
  const emitted: { type: string; extra: unknown }[] = [];
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
    get: () => ({ tenant: { id: TENANT_ID, schemaName: SCHEMA } }),
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
  const events = {
    emitIfChanged: () => null,
    emit: (type: string, _o: unknown, _s: string, _t: string, extra: unknown) => {
      emitted.push({ type, extra });
    },
  } as unknown as PaymentEvents;
  return {
    service: new PaymentOrdersService(tenantPrisma, requestContext, config, netpay, events),
    writes,
    created,
    emitted,
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
  it('returns part of the amount: stays PAID, accumulates, and announces payment.refunded', async () => {
    const f = fixture([row()]);
    const result = await f.service.refund('order-1', 'cliente', '30.00');
    expect(f.refund).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1', '30.00', 'cliente');
    expect(result).toEqual({ status: 'PAID', refundedAmount: '30.00', refunded: '30.00' });
    expect(f.emitted).toEqual([
      { type: PAYMENT_EVENTS.REFUNDED, extra: { refunded: '30.00', fullyRefunded: false } },
    ]);
  });

  it('turns REFUNDED only when the total reaches the amount', async () => {
    const f = fixture([row({ refundedAmount: new Prisma.Decimal('30.00') })]);
    const result = await f.service.refund('order-1', 'resto');
    // Not an untouched charge, so the refund service is the only route.
    expect(f.cancelCharge).not.toHaveBeenCalled();
    expect(f.refund).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-1', '70.00', 'resto');
    expect(result).toEqual({ status: 'REFUNDED', refundedAmount: '100.00', refunded: '70.00' });
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
    await expect(f.service.refund('order-1', 'x')).rejects.toThrow(/refused the request \(status 500\)/);
    expect(f.refund).not.toHaveBeenCalled();
    // The order is left refundable so the caller can retry.
    expect(f.writes.some((w) => 'refundedAmount' in w)).toBe(false);
  });
});
