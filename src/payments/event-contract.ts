import { z } from 'zod';
import { PAYMENT_EVENTS, type PaymentEventType } from './payment-events';

/**
 * The published contract of the outbound payment events (BN-REQ-EVT-011).
 *
 * This file is the source of truth. `npm run events:schemas` renders it into
 * `docs/events/<eventType>.schema.json`, the same JSON Schema goes into the
 * OpenAPI document under `x-webhooks`, and `event-contract.spec.ts` fails when
 * the files drift from it or when a payload the code really produces does not
 * validate against the files.
 *
 * Objects are closed (`additionalProperties: false`): a field added to the
 * payload without being added here fails the contract test, so the published
 * schema cannot silently fall behind the code. Subscribers should still ignore
 * fields they do not know, because the contract may grow.
 */

/** Two-decimal amount as a string; never a float. */
const money = z
  .string()
  .regex(/^\d+\.\d{2}$/)
  .meta({ description: 'Amount with two decimals, as a string (e.g. "650.00").', examples: ['650.00'] });

/** Every order status a subscriber can see in `data.status` / `data.previousStatus`. */
export const ORDER_STATUSES = [
  'PENDING',
  'PENDING_VERIFICATION',
  'CHARGE_UNKNOWN',
  'PAID',
  'PARTIALLY_REFUNDED',
  'FAILED',
  'REFUNDED',
  'AMOUNT_MISMATCH',
  'CANCELLED',
  'EXPIRED',
] as const;

const status = z.enum(ORDER_STATUSES);

/** `data`: the order as it was at the moment of the change. */
export const paymentEventDataSchema = z
  .object({
    orderId: z.uuid().meta({ description: 'Order id in this platform.' }),
    orderReference: z
      .string()
      .min(1)
      .meta({ description: 'Reference sent to Netpay as the merchant reference code.' }),
    merchantReferenceCode: z.string().min(1).meta({ description: "The tenant's own business code." }),
    amount: money,
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: status.meta({ description: 'Status after the change.' }),
    previousStatus: status.nullable().meta({ description: 'Status before the change.' }),
    refundedAmount: money.meta({ description: 'Total returned to the buyer so far.' }),
    refunded: money.optional().meta({ description: 'Amount of this refund. Only on payment.refunded.' }),
    fullyRefunded: z.boolean().meta({ description: 'True once the whole amount went back.' }),
    netpayTransactionId: z.string().nullable(),
    paymentMethod: z.enum(['CARD', 'OXXO']).nullable(),
    paymentReference: z.string().nullable().meta({ description: 'Cash reference (OXXO Pay).' }),
    failureCode: z
      .string()
      .regex(/^[A-Z_]+$/)
      .nullable()
      .meta({ description: 'Stable decline code (docs/ERRORS.md §5), e.g. INSUFFICIENT_FUNDS.' }),
    failureReason: z.string().nullable(),
  })
  .meta({ description: 'The order at the moment of the change. No cardholder data of any kind.' });

/** What each event announces, for the catalog and the schema description. */
export const EVENT_DESCRIPTIONS: Readonly<Record<PaymentEventType, string>> = {
  [PAYMENT_EVENTS.PAID]: 'The order was verified as paid against Netpay (PENDING* or CHARGE_UNKNOWN → PAID).',
  [PAYMENT_EVENTS.FAILED]:
    "Netpay reported the charge as declined or failed (→ FAILED); emitted again for each declined attempt. data.netpayTransactionId is the attempt's transaction.",
  [PAYMENT_EVENTS.MISMATCH]:
    'Netpay reported an amount different from the order; the order is not paid (→ AMOUNT_MISMATCH).',
  [PAYMENT_EVENTS.REFUNDED]:
    'Money went back to the buyer: emitted for every refund, partial (→ PARTIALLY_REFUNDED) or total (→ REFUNDED).',
  [PAYMENT_EVENTS.CANCELLED]:
    'The merchant cancelled an unpaid order (PENDING, PENDING_VERIFICATION or FAILED → CANCELLED). Netpay cannot expire a hosted session or a cash reference, so a later payment is still possible: it arrives as payment.paid_after_cancel.',
  [PAYMENT_EVENTS.EXPIRED]:
    'Reconciliation found the order never paid in time: 3-D Secure not completed within 30 min, or a cash reference past its expiry (→ EXPIRED).',
  [PAYMENT_EVENTS.PAID_AFTER_CANCEL]:
    'Netpay reported a payment for an order already CANCELLED or EXPIRED. The status does not change (data.status is still CANCELLED or EXPIRED); data.netpayTransactionId is the payment. Refund it.',
};

/**
 * The schema of one event type.
 *
 * @param eventType Event name.
 * @returns Zod schema of the delivered body.
 */
export function eventSchema(eventType: PaymentEventType) {
  return z
    .object({
      eventId: z
        .string()
        .regex(/^evt_[0-9a-f]{32}$/)
        .meta({ description: 'Stable across retries; also sent as X-MTBPay-Event-Id. Deduplicate on it.' }),
      eventType: z.literal(eventType),
      occurredAt: z.iso
        .datetime()
        .meta({ description: 'When the order changed, not when it was delivered.' }),
      sequence: z
        .number()
        .int()
        .positive()
        .meta({ description: 'Per order, strictly increasing. A gap means an event is still to come.' }),
      tenantId: z.uuid(),
      data: paymentEventDataSchema,
    })
    .meta({ title: eventType, description: EVENT_DESCRIPTIONS[eventType] });
}

/** Every published event type, in catalog order. */
export const PUBLISHED_EVENTS: readonly PaymentEventType[] = [
  PAYMENT_EVENTS.PAID,
  PAYMENT_EVENTS.FAILED,
  PAYMENT_EVENTS.MISMATCH,
  PAYMENT_EVENTS.REFUNDED,
  PAYMENT_EVENTS.CANCELLED,
  PAYMENT_EVENTS.EXPIRED,
  PAYMENT_EVENTS.PAID_AFTER_CANCEL,
];

/**
 * The JSON Schema (draft 2020-12) of one event type, as published in
 * `docs/events/<eventType>.schema.json`.
 *
 * @param eventType Event name.
 * @returns The schema document.
 */
export function eventJsonSchema(eventType: PaymentEventType): Record<string, unknown> {
  const schema = z.toJSONSchema(eventSchema(eventType), { target: 'draft-2020-12' });
  return { ...schema, $id: `${eventType}.schema.json` };
}

/**
 * File name of an event's schema under `docs/events/`.
 *
 * @param eventType Event name.
 * @returns E.g. `payment.paid.schema.json`.
 */
export function eventSchemaFile(eventType: PaymentEventType): string {
  return `${eventType}.schema.json`;
}
