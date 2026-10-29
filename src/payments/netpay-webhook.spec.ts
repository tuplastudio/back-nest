import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { INBOUND_DEDUPE_WINDOW_MS, NetpayWebhookService, inboundDedupeKey } from './netpay-webhook.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentOrdersService } from './payment-orders.service';
import type { NetpayClient } from './netpay.client';

/**
 * Inbound notification dedupe (BN-REQ-IDM-005) and the rule that nothing from the
 * unsigned payload is written before Netpay confirms it (BN-THR-015).
 */

const SCHEMA = 'tenant_acme_00000001';

/**
 * Builds the service over an in-memory tenant store that behaves like the
 * database where it matters: a second insert of the same key is a P2002.
 *
 * @param found Order the lookup returns.
 * @param transaction What Netpay answers for `GET /v3/transactions/{id}`.
 * @returns The service and its spies.
 */
function fixture(
  found: { id: string; orderReference: string } | null,
  transaction: Record<string, unknown> = { merchantReferenceCode: 'acme_orderref', status: 'IN_PROCESS' },
) {
  const seen = new Map<string, Date>();
  const client = {
    paymentWebhookEvent: {
      create: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    inboundEventSeen: {
      deleteMany: jest.fn((args: { where: { key?: string; seenAt?: { lt: Date } } }) => {
        let count = 0;
        for (const [key, at] of seen) {
          const keyMatches = args.where.key === undefined || args.where.key === key;
          const ageMatches = args.where.seenAt === undefined || at < args.where.seenAt.lt;
          if (keyMatches && ageMatches) {
            seen.delete(key);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }),
      create: jest.fn((args: { data: { key: string; seenAt: Date } }) => {
        if (seen.has(args.data.key)) {
          return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
        }
        seen.set(args.data.key, args.data.seenAt);
        return Promise.resolve({});
      }),
    },
    paymentOrder: {
      findFirst: jest.fn(() => Promise.resolve(found)),
    },
  };
  const tenantPrisma = {
    forTenantTransaction: (_s: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const cfg = { environment: 'SANDBOX', secretKey: 'sk_netpay_y' };
  const config = {
    resolveByWebhookToken: () => Promise.resolve({ tenantId: 't1', schemaName: SCHEMA }),
    getUsableInSchema: () => Promise.resolve(cfg),
  } as unknown as PaymentConfigService;
  const verifyOrderInSchema = jest.fn((..._a: unknown[]) => Promise.resolve({ status: 'PAID' }));
  const attachCashReferenceInSchema = jest.fn((..._a: unknown[]) => Promise.resolve());
  const orders = { verifyOrderInSchema, attachCashReferenceInSchema } as unknown as PaymentOrdersService;
  const getTransaction = jest.fn((..._a: unknown[]) => Promise.resolve(transaction));
  const netpay = { getTransaction } as unknown as NetpayClient;
  return {
    service: new NetpayWebhookService(tenantPrisma, config, orders, netpay),
    verifyOrderInSchema,
    attachCashReferenceInSchema,
    getTransaction,
    client,
  };
}

const PAID = {
  event: 'sessionLink.paid',
  data: { transactionId: 'tx-1', sessionId: 'sess-1', status: 'DONE' },
};

describe('Inbound notification dedupe (BN-TASK-012)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('derives a deterministic key from eventType|transactionId|status', () => {
    const expected = createHash('sha256').update('sessionLink.paid|tx-1|DONE').digest('hex');
    expect(inboundDedupeKey('sessionLink.paid', 'tx-1', 'DONE')).toBe(expected);
    expect(inboundDedupeKey('sessionLink.paid', 'tx-1', 'DONE')).toBe(expected);
    expect(inboundDedupeKey('sessionLink.paid', null, null)).toBe(
      createHash('sha256').update('sessionLink.paid||').digest('hex'),
    );
  });

  it('verifies once when the same notification arrives 5 times in a minute', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    jest.useFakeTimers({ now: new Date('2026-10-21T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    for (let i = 0; i < 5; i += 1) {
      jest.setSystemTime(new Date(Date.parse('2026-10-21T10:00:00Z') + i * 10_000));
      await f.service.receive('token', PAID);
    }
    expect(f.verifyOrderInSchema).toHaveBeenCalledTimes(1);
    // Every copy is still recorded as evidence.
    expect(f.client.paymentWebhookEvent.create).toHaveBeenCalledTimes(5);
  });

  it('verifies again once the 10-minute window has passed', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    jest.useFakeTimers({ now: new Date('2026-10-21T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    await f.service.receive('token', PAID);
    jest.setSystemTime(new Date(Date.parse('2026-10-21T10:00:00Z') + INBOUND_DEDUPE_WINDOW_MS + 1_000));
    await f.service.receive('token', PAID);
    expect(f.verifyOrderInSchema).toHaveBeenCalledTimes(2);
  });

  it('treats a different status for the same transaction as a new notification', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    await f.service.receive('token', PAID);
    await f.service.receive('token', { ...PAID, data: { ...PAID.data, status: 'CANCELED' } });
    expect(f.verifyOrderInSchema).toHaveBeenCalledTimes(2);
  });

  it('does not let a forged copy pre-empt the real notification (claimed status not confirmed)', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    // Forged "DONE" while Netpay still has the charge pending: nothing is concluded.
    f.verifyOrderInSchema.mockResolvedValueOnce({ status: 'PENDING_VERIFICATION' });
    await f.service.receive('token', PAID);
    // Netpay's own notification, same (event, transaction, status), once it settled.
    await f.service.receive('token', PAID);
    expect(f.verifyOrderInSchema).toHaveBeenCalledTimes(2);
    // Now confirmed: further copies are duplicates again.
    await f.service.receive('token', PAID);
    expect(f.verifyOrderInSchema).toHaveBeenCalledTimes(2);
  });

  it('does not hold the key for a notification whose order is unknown', async () => {
    const f = fixture(null);
    await f.service.receive('token', PAID);
    expect(f.client.inboundEventSeen.deleteMany).toHaveBeenLastCalledWith({
      where: { key: inboundDedupeKey('sessionLink.paid', 'tx-1', 'DONE') },
    });
  });

  it('lets a retry verify again when the verification itself failed', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    f.verifyOrderInSchema.mockRejectedValueOnce(new Error('timeout'));
    await f.service.receive('token', PAID);
    await f.service.receive('token', PAID);
    expect(f.verifyOrderInSchema).toHaveBeenCalledTimes(2);
  });
});

describe('Cash reference is only taken once Netpay confirms it (BN-THR-015)', () => {
  it('does not attach a reference from a notification without a transaction to check', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    await f.service.receive('token', {
      event: 'oxxopay.new',
      data: { reference: '9201170000000001', merchantReferenceCode: 'acme_orderref' },
    });
    expect(f.attachCashReferenceInSchema).not.toHaveBeenCalled();
  });

  it('attaches the reference after Netpay says the transaction is this order’s', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    await f.service.receive('token', {
      event: 'cep.created',
      data: { transactionId: 'tx-c', reference: '9201170000000009', merchantRefCode: 'acme_orderref' },
    });
    expect(f.getTransaction).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'tx-c');
    expect(f.attachCashReferenceInSchema).toHaveBeenCalledWith(SCHEMA, 'order-1', '9201170000000009', null);
    // Netpay was asked before anything was written.
    expect(f.getTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      f.attachCashReferenceInSchema.mock.invocationCallOrder[0],
    );
  });

  it('refuses the reference when Netpay names another order for the transaction', async () => {
    const f = fixture(
      { id: 'order-1', orderReference: 'acme_orderref' },
      { merchantReferenceCode: 'someone_else', status: 'IN_PROCESS' },
    );
    await f.service.receive('token', {
      event: 'cep.created',
      data: { transactionId: 'tx-c', reference: '9201170000000009', merchantRefCode: 'acme_orderref' },
    });
    expect(f.attachCashReferenceInSchema).not.toHaveBeenCalled();
  });

  it('refuses the reference when Netpay cannot be asked', async () => {
    const f = fixture({ id: 'order-1', orderReference: 'acme_orderref' });
    f.getTransaction.mockRejectedValueOnce(new Error('timeout'));
    await f.service.receive('token', {
      event: 'cep.created',
      data: { transactionId: 'tx-c', reference: '9201170000000009', merchantRefCode: 'acme_orderref' },
    });
    expect(f.attachCashReferenceInSchema).not.toHaveBeenCalled();
  });
});
