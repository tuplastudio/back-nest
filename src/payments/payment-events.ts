import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/tenant-plane/client';
import { PaymentSecretBox } from './payment-secret-box';
import { OutboundDispatcher } from './outbound/outbound-dispatcher.service';

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
} as const;

/** Every event name the platform can emit. */
export const ALL_PAYMENT_EVENTS: readonly string[] = Object.values(PAYMENT_EVENTS);

/** Maps an internal order status to the event subscribers receive. */
const EVENT_FOR_STATUS: Readonly<Record<string, string>> = {
  PAID: PAYMENT_EVENTS.PAID,
  FAILED: PAYMENT_EVENTS.FAILED,
  AMOUNT_MISMATCH: PAYMENT_EVENTS.MISMATCH,
  REFUNDED: PAYMENT_EVENTS.REFUNDED,
};

/**
 * Emits payment events to a tenant's outbound subscribers.
 *
 * Delivery is queued rather than performed inline: a slow subscriber must never
 * delay a webhook response or a verification.
 */
@Injectable()
export class PaymentEvents {
  constructor(private readonly dispatcher: OutboundDispatcher) {}

  /**
   * Emits the event matching a status transition, if it changed anything.
   *
   * @param previous Status before the transition.
   * @param current Status after it.
   * @param order The order the event describes.
   * @returns The event name emitted, or `null` when nothing changed.
   */
  emitIfChanged(
    previous: string,
    current: string,
    order: OrderForEvent,
    schemaName: string,
    tenantId: string,
  ): string | null {
    if (previous === current) {
      return null;
    }
    const eventType = EVENT_FOR_STATUS[current];
    if (eventType === undefined) {
      // Pending states are not subscriber-visible: nobody needs to know an order
      // is still waiting.
      return null;
    }
    this.emit(eventType, order, schemaName, tenantId);
    return eventType;
  }

  /**
   * Queues an event for delivery to every matching subscriber.
   *
   * @param eventType Event name.
   * @param order The order the event describes.
   */
  emit(
    eventType: string,
    order: OrderForEvent,
    schemaName: string,
    tenantId: string,
    extra: Readonly<Record<string, string | boolean>> = {},
  ): void {
    const body = {
      eventType,
      tenantId,
      orderId: order.id,
      orderReference: order.orderReference,
      merchantReferenceCode: order.merchantReferenceCode,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      status: order.status,
      sequence: order.sequence,
      // Method and cash reference let the receiving platform show how it was paid; the
      // transaction id is what a refund is keyed on. None of them is personal data.
      paymentMethod: order.paymentMethod ?? null,
      paymentReference: order.paymentReference ?? null,
      netpayTransactionId: order.netpayTransactionId ?? null,
      refundedAmount: order.refundedAmount === undefined ? '0.00' : order.refundedAmount.toFixed(2),
      failureReason: order.failureReason ?? null,
      ...extra,
      occurredAt: new Date().toISOString(),
    };
    // Deliberately no cardholder field of any kind.
    // Queued without waiting: emitting must not delay the verification that
    // produced it. A failure to queue is logged by the dispatcher.
    void this.dispatcher.queue(eventType, tenantId, schemaName, body);
  }
}

/** The subset of an order an event describes. */
export interface OrderForEvent {
  readonly id: string;
  readonly orderReference: string;
  readonly merchantReferenceCode: string;
  readonly amount: Prisma.Decimal;
  readonly currency: string;
  readonly status: string;
  readonly sequence: number;
  readonly paymentMethod?: string | null;
  readonly paymentReference?: string | null;
  readonly netpayTransactionId?: string | null;
  readonly refundedAmount?: Prisma.Decimal;
  readonly failureReason?: string | null;
}

/** Re-exported so the module can wire the signer without a cycle. */
export { PaymentSecretBox };
