import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Prisma } from '../generated/tenant-plane/client';
import {
  ALL_PAYMENT_EVENTS,
  PAYMENT_EVENTS,
  PaymentEvents,
  serializeEventPayload,
  type EventOrderSnapshot,
  type OutboxClient,
  type PaymentEventPayload,
  type RecordEventInput,
} from './payment-events';
import { PUBLISHED_EVENTS, eventJsonSchema, eventSchemaFile } from './event-contract';

/**
 * Contract test of the outbound events (BN-TASK-009, BN-REQ-EVT-011).
 *
 * 1. `docs/events/*.schema.json` are exactly what `event-contract.ts` renders
 *    (`npm run events:schemas` regenerates them).
 * 2. Payloads produced by the real outbox writer, for each event and the
 *    transitions that emit it, validate against the files on disk, after the
 *    same serialisation the dispatcher signs and sends.
 */

const EVENTS_DIR = join(process.cwd(), 'docs', 'events');
const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

/** The schema as published, compiled from the file rather than from the source. */
function published(eventType: string): z.ZodType {
  const json = JSON.parse(readFileSync(join(EVENTS_DIR, `${eventType}.schema.json`), 'utf8')) as Record<
    string,
    unknown
  >;
  return z.fromJSONSchema(json);
}

function order(over: Partial<EventOrderSnapshot> = {}): EventOrderSnapshot {
  return {
    id: ORDER_ID,
    orderReference: 'acme_8f2c1d',
    merchantReferenceCode: 'PEDIDO-1042',
    amount: new Prisma.Decimal('650'),
    currency: 'MXN',
    status: 'PAID',
    netpayTransactionId: 'b1c2d3e4-txn',
    paymentMethod: 'CARD',
    paymentReference: null,
    refundedAmount: new Prisma.Decimal('0'),
    failureReason: null,
    failureCode: null,
    ...over,
  };
}

/**
 * Runs the real writer over a fake client and returns what it persisted.
 *
 * @param input Event to record.
 * @returns The payload as it would be read back and delivered.
 */
async function written(input: Omit<RecordEventInput, 'tenantId' | 'occurredAt'>): Promise<unknown> {
  let stored: PaymentEventPayload | undefined;
  const client = {
    paymentOrder: { update: () => Promise.resolve({ eventSequence: 3 }) },
    paymentEventOutbox: {
      create: (args: { data: { payload: PaymentEventPayload } }) => {
        stored = args.data.payload;
        return Promise.resolve({});
      },
    },
  } as unknown as OutboxClient;
  await new PaymentEvents().record(client, { ...input, tenantId: TENANT, occurredAt: new Date() });
  // Exactly the bytes the dispatcher signs and sends.
  return JSON.parse(serializeEventPayload(stored as PaymentEventPayload)) as unknown;
}

/** One real payload per (event, transition) the code produces. */
const CASES: [string, () => Promise<unknown>][] = [
  [
    'payment.paid by card',
    () => written({ eventType: PAYMENT_EVENTS.PAID, previousStatus: 'PENDING', order: order() }),
  ],
  [
    'payment.paid in cash (OXXO)',
    () =>
      written({
        eventType: PAYMENT_EVENTS.PAID,
        previousStatus: 'PENDING_VERIFICATION',
        order: order({ paymentMethod: 'OXXO', paymentReference: '9201179201915626' }),
      }),
  ],
  [
    'payment.failed with a decline code',
    () =>
      written({
        eventType: PAYMENT_EVENTS.FAILED,
        previousStatus: 'PENDING',
        order: order({
          status: 'FAILED',
          paymentMethod: null,
          failureCode: 'INSUFFICIENT_FUNDS',
          failureReason: 'The provider reported the charge as unsuccessful.',
        }),
      }),
  ],
  [
    'payment.mismatch',
    () =>
      written({
        eventType: PAYMENT_EVENTS.MISMATCH,
        previousStatus: 'PENDING',
        order: order({
          status: 'AMOUNT_MISMATCH',
          paymentMethod: null,
          failureReason: 'Amount reported by the provider does not match the order.',
        }),
      }),
  ],
  [
    'payment.refunded, partial',
    () =>
      written({
        eventType: PAYMENT_EVENTS.REFUNDED,
        previousStatus: 'PAID',
        order: order({ status: 'PARTIALLY_REFUNDED', refundedAmount: new Prisma.Decimal('100') }),
        refunded: new Prisma.Decimal('100'),
      }),
  ],
  [
    'payment.refunded, the rest',
    () =>
      written({
        eventType: PAYMENT_EVENTS.REFUNDED,
        previousStatus: 'PARTIALLY_REFUNDED',
        order: order({ status: 'REFUNDED', refundedAmount: new Prisma.Decimal('650') }),
        refunded: new Prisma.Decimal('550'),
      }),
  ],
  [
    'payment.cancelled (BN-REQ-PAY-004)',
    () =>
      written({
        eventType: PAYMENT_EVENTS.CANCELLED,
        previousStatus: 'PENDING',
        order: order({ status: 'CANCELLED', paymentMethod: null, netpayTransactionId: null }),
      }),
  ],
  [
    'payment.expired, 3-D Secure abandoned (BN-REQ-REC-002)',
    () =>
      written({
        eventType: PAYMENT_EVENTS.EXPIRED,
        previousStatus: 'PENDING_VERIFICATION',
        order: order({
          status: 'EXPIRED',
          paymentMethod: null,
          failureReason: 'The buyer never completed 3-D Secure.',
        }),
      }),
  ],
  [
    'payment.expired, cash reference past its expiry (BN-REQ-REC-003)',
    () =>
      written({
        eventType: PAYMENT_EVENTS.EXPIRED,
        previousStatus: 'PENDING',
        order: order({
          status: 'EXPIRED',
          paymentMethod: 'OXXO',
          paymentReference: '9201179201915626',
          netpayTransactionId: null,
        }),
      }),
  ],
  [
    'payment.paid_after_cancel (BN-REQ-PAY-004)',
    () =>
      written({
        eventType: PAYMENT_EVENTS.PAID_AFTER_CANCEL,
        previousStatus: 'CANCELLED',
        order: order({ status: 'CANCELLED' }),
      }),
  ],
];

describe('event schemas in docs/events (BN-TASK-009)', () => {
  it('publishes one schema per event of the catalog, and nothing else', () => {
    const files = readdirSync(EVENTS_DIR)
      .filter((name) => name.endsWith('.schema.json'))
      .sort();
    expect(files).toEqual([...ALL_PAYMENT_EVENTS].map((e) => `${e}.schema.json`).sort());
    expect([...PUBLISHED_EVENTS].sort()).toEqual([...ALL_PAYMENT_EVENTS].sort());
  });

  it('lists every event in catalog.json with its schema file', () => {
    const catalog = JSON.parse(readFileSync(join(EVENTS_DIR, 'catalog.json'), 'utf8')) as {
      events: { eventType: string; schema: string }[];
    };
    expect(catalog.events.map((e) => [e.eventType, e.schema])).toEqual(
      PUBLISHED_EVENTS.map((e) => [e, eventSchemaFile(e)]),
    );
  });

  it.each([...PUBLISHED_EVENTS])('%s.schema.json is in sync with event-contract.ts', (eventType) => {
    const onDisk = JSON.parse(readFileSync(join(EVENTS_DIR, eventSchemaFile(eventType)), 'utf8')) as unknown;
    expect(onDisk).toEqual(eventJsonSchema(eventType));
  });
});

describe('real payloads against the published schemas (BN-REQ-EVT-011)', () => {
  it.each(CASES)('%s validates', async (_label, produce) => {
    const payload = (await produce()) as { eventType: string };
    const result = published(payload.eventType).safeParse(payload);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('rejects a payload without its sequence or with a float amount', async () => {
    const payload = (await written({
      eventType: PAYMENT_EVENTS.PAID,
      previousStatus: 'PENDING',
      order: order(),
    })) as Record<string, unknown> & { data: Record<string, unknown> };
    const schema = published('payment.paid');
    const { sequence: _sequence, ...withoutSequence } = payload;
    expect(schema.safeParse(withoutSequence).success).toBe(false);
    expect(schema.safeParse({ ...payload, data: { ...payload.data, amount: 650 } }).success).toBe(false);
    // An event of one type does not validate as another.
    expect(published('payment.failed').safeParse(payload).success).toBe(false);
  });
});
