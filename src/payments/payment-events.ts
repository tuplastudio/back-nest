import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient as TenantClient } from '../generated/tenant-plane/client';
import { PaymentSecretBox } from './payment-secret-box';

/**
 * The event catalog.
 *
 * Events are named `resource.state` and are emitted only from a **verified**
 * state. Nothing in this list may be produced from the inbound notification
 * payload: that payload is unsigned, so treating it as fact would propagate the
 * exact defect the payment verification exists to prevent.
 */
export const PAYMENT_EVENTS = {
  PAID: 'payment.paid',
  FAILED: 'payment.failed',
  MISMATCH: 'payment.mismatch',
  REFUNDED: 'payment.refunded',
  /** The merchant cancelled an unpaid order (BN-REQ-PAY-004). */
  CANCELLED: 'payment.cancelled',
  /** Reconciliation found the order never paid in time (BN-REQ-REC-002/003). */
  EXPIRED: 'payment.expired',
  /**
   * Netpay reported a payment for an order already CANCELLED or EXPIRED. The status
   * stays; the consumer is expected to refund.
   */
  PAID_AFTER_CANCEL: 'payment.paid_after_cancel',
} as const;

/** One event name of the catalog. */
export type PaymentEventType = (typeof PAYMENT_EVENTS)[keyof typeof PAYMENT_EVENTS];

/** Every event name the platform can emit. */
export const ALL_PAYMENT_EVENTS: readonly string[] = Object.values(PAYMENT_EVENTS);

/** Maps an internal order status to the event subscribers receive. */
const EVENT_FOR_STATUS: Readonly<Record<string, PaymentEventType>> = {
  PAID: PAYMENT_EVENTS.PAID,
  FAILED: PAYMENT_EVENTS.FAILED,
  AMOUNT_MISMATCH: PAYMENT_EVENTS.MISMATCH,
  PARTIALLY_REFUNDED: PAYMENT_EVENTS.REFUNDED,
  REFUNDED: PAYMENT_EVENTS.REFUNDED,
  CANCELLED: PAYMENT_EVENTS.CANCELLED,
  EXPIRED: PAYMENT_EVENTS.EXPIRED,
};

/**
 * The event a status transition produces.
 *
 * Pending states are not subscriber-visible: nobody needs to know an order is
 * still waiting.
 *
 * @param previous Status before the change.
 * @param current Status after it.
 * @returns The event name, or `null` when the transition announces nothing.
 */
export function eventForTransition(previous: string, current: string): PaymentEventType | null {
  if (previous === current) {
    return null;
  }
  return EVENT_FOR_STATUS[current] ?? null;
}

/** The order fields an event describes, as read inside the changing transaction. */
export interface EventOrderSnapshot {
  readonly id: string;
  readonly orderReference: string;
  readonly merchantReferenceCode: string;
  readonly amount: Prisma.Decimal;
  readonly currency: string;
  readonly status: string;
  readonly netpayTransactionId?: string | null;
  readonly paymentMethod?: string | null;
  readonly paymentReference?: string | null;
  readonly refundedAmount?: Prisma.Decimal;
  readonly failureReason?: string | null;
  readonly failureCode?: string | null;
}

/** `data` of an event: the order as it was at the moment of the change. */
export interface PaymentEventData {
  readonly orderId: string;
  readonly orderReference: string;
  readonly merchantReferenceCode: string;
  /** Two-decimal string, never a float. */
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  /** Status before this change. */
  readonly previousStatus: string | null;
  /** Total returned to the buyer so far. */
  readonly refundedAmount: string;
  /** Amount returned by this refund; only on `payment.refunded`. */
  readonly refunded?: string;
  readonly fullyRefunded: boolean;
  readonly netpayTransactionId: string | null;
  /** `CARD` or `OXXO`. */
  readonly paymentMethod: string | null;
  /** Cash reference (OXXO Pay). */
  readonly paymentReference: string | null;
  /** Stable decline code (BN-REQ-PAY-006); Netpay's own code stays internal. */
  readonly failureCode: string | null;
  readonly failureReason: string | null;
}

/** The body delivered to subscribers, persisted verbatim in the outbox (BN-REQ-EVT-005). */
export interface PaymentEventPayload {
  readonly eventId: string;
  readonly eventType: string;
  /** When the change happened, not when it was delivered. */
  readonly occurredAt: string;
  /** Per order, strictly increasing. */
  readonly sequence: number;
  readonly tenantId: string;
  readonly data: PaymentEventData;
}

/**
 * Builds the event snapshot. Pure, so the wire format is fixed by unit tests and
 * by the published JSON Schema (`docs/events/`).
 *
 * Deliberately no cardholder field of any kind.
 *
 * @param input Identity, timing and the order as changed.
 * @returns The payload.
 */
export function buildEventPayload(input: {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly sequence: number;
  readonly tenantId: string;
  readonly previousStatus: string | null;
  readonly order: EventOrderSnapshot;
  /** Amount of this refund, for `payment.refunded`. */
  readonly refunded?: Prisma.Decimal;
}): PaymentEventPayload {
  const { order } = input;
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    sequence: input.sequence,
    tenantId: input.tenantId,
    data: {
      orderId: order.id,
      orderReference: order.orderReference,
      merchantReferenceCode: order.merchantReferenceCode,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      status: order.status,
      previousStatus: input.previousStatus,
      refundedAmount: (order.refundedAmount ?? new Prisma.Decimal(0)).toFixed(2),
      ...(input.refunded === undefined ? {} : { refunded: input.refunded.toFixed(2) }),
      fullyRefunded: order.status === 'REFUNDED',
      netpayTransactionId: order.netpayTransactionId ?? null,
      paymentMethod: order.paymentMethod ?? null,
      paymentReference: order.paymentReference ?? null,
      failureCode: order.failureCode ?? null,
      failureReason: order.failureReason ?? null,
    },
  };
}

/** Field order of `data` on the wire. */
const DATA_FIELD_ORDER: readonly (keyof PaymentEventData)[] = [
  'orderId',
  'orderReference',
  'merchantReferenceCode',
  'amount',
  'currency',
  'status',
  'previousStatus',
  'refundedAmount',
  'refunded',
  'fullyRefunded',
  'netpayTransactionId',
  'paymentMethod',
  'paymentReference',
  'failureCode',
  'failureReason',
];

/**
 * Serialises a persisted snapshot into the exact body that is signed and sent.
 *
 * `jsonb` does not keep key order, so the order is restored here: a subscriber
 * sees the same field order on every delivery and every retry. Keys outside the
 * known set (from a newer writer) are kept, after the known ones.
 *
 * @param payload Snapshot as read back from the outbox.
 * @returns The body string.
 */
export function serializeEventPayload(payload: PaymentEventPayload): string {
  const data = payload.data as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of DATA_FIELD_ORDER) {
    if (key in data) {
      ordered[key] = data[key];
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in ordered)) {
      ordered[key] = value;
    }
  }
  return JSON.stringify({
    eventId: payload.eventId,
    eventType: payload.eventType,
    occurredAt: payload.occurredAt,
    sequence: payload.sequence,
    tenantId: payload.tenantId,
    data: ordered,
  });
}

/**
 * The event id of an outbox row: one identity from the write to the subscriber's
 * `X-MTBPay-Event-Id`.
 *
 * @param outboxId Outbox row id (UUID).
 * @returns `evt_` followed by the UUID's 32 hex digits.
 */
export function eventIdFor(outboxId: string): string {
  return `evt_${outboxId.replace(/-/g, '')}`;
}

/** The two tables the writer touches, on the transaction that changes the order. */
export type OutboxClient = Pick<TenantClient, 'paymentOrder' | 'paymentEventOutbox'>;

/** What {@link PaymentEvents.record} needs. */
export interface RecordEventInput {
  readonly eventType: PaymentEventType;
  readonly tenantId: string;
  readonly previousStatus: string | null;
  /** The order as the same transaction just wrote it. */
  readonly order: EventOrderSnapshot;
  /** Time of the change. */
  readonly occurredAt: Date;
  /** Amount of this refund, for `payment.refunded`. */
  readonly refunded?: Prisma.Decimal;
}

/**
 * Writes payment events to the transactional outbox (BN-REQ-EVT-004).
 *
 * The caller passes the transaction client that changed the order, so the event
 * commits or rolls back with the change: a rollback leaves no event, and a crash
 * after the commit leaves one the dispatcher still delivers. Delivery itself is
 * the dispatcher's business; nothing here waits on a subscriber.
 */
@Injectable()
export class PaymentEvents {
  /**
   * Records one event for an order.
   *
   * The sequence comes from an atomic `eventSequence + 1` on the order row, which
   * the changing transaction already holds locked, so events of one order carry
   * strictly increasing numbers even across concurrent writers.
   *
   * @param tx Transaction client that changed the order.
   * @param input Event type, tenant and the order as changed.
   * @returns The persisted payload.
   */
  async record(tx: OutboxClient, input: RecordEventInput): Promise<PaymentEventPayload> {
    const { eventSequence } = await tx.paymentOrder.update({
      where: { id: input.order.id },
      data: { eventSequence: { increment: 1 } },
      select: { eventSequence: true },
    });
    const id = randomUUID();
    const payload = buildEventPayload({
      eventId: eventIdFor(id),
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      sequence: eventSequence,
      tenantId: input.tenantId,
      previousStatus: input.previousStatus,
      order: input.order,
      ...(input.refunded === undefined ? {} : { refunded: input.refunded }),
    });
    await tx.paymentEventOutbox.create({
      data: {
        id,
        orderId: input.order.id,
        sequence: eventSequence,
        eventType: input.eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
        occurredAt: input.occurredAt,
      },
    });
    return payload;
  }
}

/** Re-exported so the module can wire the signer without a cycle. */
export { PaymentSecretBox };
