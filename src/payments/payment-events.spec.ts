import { Prisma } from '../generated/tenant-plane/client';
import {
  PAYMENT_EVENTS,
  PaymentEvents,
  buildEventPayload,
  eventForTransition,
  type EventOrderSnapshot,
  type OutboxClient,
} from './payment-events';

/**
 * The event writer of the transactional outbox (BN-REQ-EVT-004/005/006).
 *
 * The client is a fake of the two tables it touches. What is fixed here is the
 * snapshot that is persisted (field set, formats, `occurredAt` = time of the
 * change) and the per-order sequence.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHANGED_AT = new Date('2026-10-21T12:00:00.000Z');

function order(over: Partial<EventOrderSnapshot> = {}): EventOrderSnapshot {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    orderReference: 'acme_ref1',
    merchantReferenceCode: 'PLANE-1',
    amount: new Prisma.Decimal('100'),
    currency: 'MXN',
    status: 'PAID',
    netpayTransactionId: 'tx-1',
    paymentMethod: 'CARD',
    paymentReference: null,
    refundedAmount: new Prisma.Decimal('0'),
    failureReason: null,
    failureCode: null,
    ...over,
  };
}

/** In-memory `payment_orders.eventSequence` and `payment_event_outbox`. */
function fakeClient() {
  const sequences = new Map<string, number>();
  const outbox: {
    id: string;
    orderId: string;
    sequence: number;
    eventType: string;
    payload: unknown;
    occurredAt: Date;
  }[] = [];
  const client = {
    paymentOrder: {
      update: (args: { where: { id: string }; data: { eventSequence: { increment: number } } }) => {
        const next = (sequences.get(args.where.id) ?? 0) + args.data.eventSequence.increment;
        sequences.set(args.where.id, next);
        return Promise.resolve({ eventSequence: next });
      },
    },
    paymentEventOutbox: {
      create: (args: { data: (typeof outbox)[number] }) => {
        outbox.push(args.data);
        return Promise.resolve(args.data);
      },
    },
  } as unknown as OutboxClient;
  return { client, outbox };
}

describe('eventForTransition', () => {
  it.each([
    ['PENDING', 'PAID', PAYMENT_EVENTS.PAID],
    ['PENDING_VERIFICATION', 'FAILED', PAYMENT_EVENTS.FAILED],
    ['PENDING', 'AMOUNT_MISMATCH', PAYMENT_EVENTS.MISMATCH],
    ['PAID', 'PARTIALLY_REFUNDED', PAYMENT_EVENTS.REFUNDED],
    ['PARTIALLY_REFUNDED', 'REFUNDED', PAYMENT_EVENTS.REFUNDED],
    ['PAID', 'REFUNDED', PAYMENT_EVENTS.REFUNDED],
    ['PENDING', 'CANCELLED', PAYMENT_EVENTS.CANCELLED],
    ['FAILED', 'CANCELLED', PAYMENT_EVENTS.CANCELLED],
    ['PENDING_VERIFICATION', 'EXPIRED', PAYMENT_EVENTS.EXPIRED],
  ])('%s → %s emits %s', (from, to, expected) => {
    expect(eventForTransition(from, to)).toBe(expected);
  });

  it('emits nothing for a pending state or for no change', () => {
    expect(eventForTransition('PENDING', 'PENDING_VERIFICATION')).toBeNull();
    expect(eventForTransition('PAID', 'PAID')).toBeNull();
  });
});

describe('buildEventPayload (snapshot serialisation)', () => {
  it('carries every field of the contract, in its wire format', () => {
    const payload = buildEventPayload({
      eventId: 'evt_abc',
      eventType: PAYMENT_EVENTS.REFUNDED,
      occurredAt: CHANGED_AT,
      sequence: 3,
      tenantId: TENANT,
      previousStatus: 'PAID',
      order: order({ status: 'PARTIALLY_REFUNDED', refundedAmount: new Prisma.Decimal('30') }),
      refunded: new Prisma.Decimal('30'),
    });
    expect(payload).toEqual({
      eventId: 'evt_abc',
      eventType: 'payment.refunded',
      occurredAt: '2026-10-21T12:00:00.000Z',
      sequence: 3,
      tenantId: TENANT,
      data: {
        orderId: '22222222-2222-4222-8222-222222222222',
        orderReference: 'acme_ref1',
        merchantReferenceCode: 'PLANE-1',
        amount: '100.00',
        currency: 'MXN',
        status: 'PARTIALLY_REFUNDED',
        previousStatus: 'PAID',
        refundedAmount: '30.00',
        refunded: '30.00',
        fullyRefunded: false,
        netpayTransactionId: 'tx-1',
        paymentMethod: 'CARD',
        paymentReference: null,
        failureCode: null,
        failureReason: null,
      },
    });
  });

  it('marks a fully refunded order', () => {
    const payload = buildEventPayload({
      eventId: 'evt_x',
      eventType: PAYMENT_EVENTS.REFUNDED,
      occurredAt: CHANGED_AT,
      sequence: 2,
      tenantId: TENANT,
      previousStatus: 'PAID',
      order: order({ status: 'REFUNDED', refundedAmount: new Prisma.Decimal('100') }),
    });
    expect(payload.data.fullyRefunded).toBe(true);
    expect(payload.data).not.toHaveProperty('refunded');
  });

  it('carries no cardholder field of any kind', () => {
    const payload = buildEventPayload({
      eventId: 'evt_x',
      eventType: PAYMENT_EVENTS.PAID,
      occurredAt: CHANGED_AT,
      sequence: 1,
      tenantId: TENANT,
      previousStatus: 'PENDING',
      order: order(),
    });
    expect(JSON.stringify(payload)).not.toMatch(/card(Number|holder)|cvv|pan|email/i);
  });
});

describe('PaymentEvents.record (outbox write)', () => {
  it('writes the snapshot with the time of the change and the next per-order sequence', async () => {
    const { client, outbox } = fakeClient();
    const events = new PaymentEvents();
    const paid = await events.record(client, {
      eventType: PAYMENT_EVENTS.PAID,
      tenantId: TENANT,
      previousStatus: 'PENDING',
      order: order(),
      occurredAt: CHANGED_AT,
    });
    expect(paid.sequence).toBe(1);
    expect(paid.occurredAt).toBe(CHANGED_AT.toISOString());
    expect(paid.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      orderId: order().id,
      sequence: 1,
      eventType: 'payment.paid',
      occurredAt: CHANGED_AT,
      payload: paid,
    });
    // The outbox row id is the event id: one identity from the write to the subscriber.
    expect(paid.eventId).toBe(`evt_${outbox[0].id.replace(/-/g, '')}`);
  });

  it('gives a partial refund sequence + 1 and the refunded amount (BN-REQ-EVT-006)', async () => {
    const { client, outbox } = fakeClient();
    const events = new PaymentEvents();
    await events.record(client, {
      eventType: PAYMENT_EVENTS.PAID,
      tenantId: TENANT,
      previousStatus: 'PENDING',
      order: order(),
      occurredAt: CHANGED_AT,
    });
    const refunded = await events.record(client, {
      eventType: PAYMENT_EVENTS.REFUNDED,
      tenantId: TENANT,
      previousStatus: 'PAID',
      order: order({ status: 'PARTIALLY_REFUNDED', refundedAmount: new Prisma.Decimal('30') }),
      occurredAt: new Date(CHANGED_AT.getTime() + 1000),
      refunded: new Prisma.Decimal('30'),
    });
    expect(refunded.sequence).toBe(2);
    expect(refunded.data.refundedAmount).toBe('30.00');
    expect(refunded.data.fullyRefunded).toBe(false);
    expect(outbox.map((row) => row.sequence)).toEqual([1, 2]);
  });
});
