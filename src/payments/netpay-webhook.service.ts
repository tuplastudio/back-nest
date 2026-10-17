import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { PaymentConfigService } from './payment-config.service';
import { PaymentOrdersService } from './payment-orders.service';

/**
 * Payload fields of an inbound notification that are safe to keep.
 *
 * The notification carries `cardHolderName`, `customerEmail`, `lastFourDigits`
 * and `bankName`. Those are personal data, and none of them is needed to
 * reconcile a payment, so they are dropped rather than stored.
 */
const RETAINED_EVENT_FIELDS = [
  'transactionId',
  'sessionId',
  'orderId',
  'reference',
  'merchantReferenceCode',
  'merchantRefCode',
  'folio',
  'referenceType',
  'confirmDate',
  'status',
  'transactionStatus',
  'responseCode',
  'amount',
  'createdAt',
  'authDate',
] as const;

/**
 * Reports whether an error is a unique-constraint violation.
 *
 * @param error Caught value.
 * @returns `true` for Prisma's P2002.
 */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === 'P2002';
}

/** An inbound notification, as documented. */
export interface InboundNetpayEvent {
  readonly event?: string;
  readonly type?: string | null;
  readonly createdAt?: number;
  readonly data?: Record<string, unknown>;
}

/** Everything resolved from the opaque token in the webhook URL. */
export interface ResolvedWebhookRoute {
  readonly tenantId: string;
  readonly schemaName: string;
}

/**
 * Records and verifies inbound payment notifications.
 *
 * The notification is **not signed**, so it is never evidence that a payment
 * happened: its whole job is to say "come and ask the API". Two consequences
 * shape this service.
 *
 * The tenant is resolved from an opaque token embedded in the URL, never from
 * `X-Tenant-Id`. That header is caller-supplied and an unsigned notification
 * proves nothing about who sent it, so trusting it would let anyone mark any
 * order in any tenant as under verification.
 *
 * And nothing about the outcome is ever reflected back. An unauthenticated route
 * that distinguishes "unknown tenant" from "unknown order" is an enumeration
 * oracle, so every outcome is the same to the caller.
 */
@Injectable()
export class NetpayWebhookService {
  private readonly logger = new Logger(NetpayWebhookService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly config: PaymentConfigService,
    private readonly orders: PaymentOrdersService,
  ) {}

  /**
   * Handles one notification.
   *
   * @param token Opaque token from the webhook URL.
   * @param payload Body as received.
   * @returns Nothing; the caller always answers the same way.
   */
  async receive(token: string, payload: InboundNetpayEvent): Promise<void> {
    const route = await this.resolve(token);
    if (route === null) {
      this.logger.warn('Payment notification received with an unrecognised webhook token.');
      return;
    }
    const { schemaName, tenantId } = route;

    const eventType = typeof payload.event === 'string' ? payload.event : 'unknown';
    const data = payload.data ?? {};
    const transactionId = typeof data['transactionId'] === 'string' ? data['transactionId'] : null;
    const reference = typeof data['reference'] === 'string' ? data['reference'] : null;
    // A Checkout Hosted notification names the payment by `sessionId` and carries
    // neither the order reference nor the merchant reference code.
    const sessionId = typeof data['sessionId'] === 'string' ? data['sessionId'] : null;
    // A cash notification (`oxxopay.paid`, `cep.*`) carries the merchant reference the
    // reference was created with, which is the order reference.
    const merchantRef =
      typeof data['merchantRefCode'] === 'string'
        ? data['merchantRefCode']
        : typeof data['merchantReferenceCode'] === 'string'
          ? data['merchantReferenceCode']
          : null;
    const eventId = `ntf_${randomUUID().replace(/-/g, '')}`;

    const stored = await this.recordEvent(schemaName, eventId, eventType, transactionId, payload);
    if (!stored) {
      // A redelivery of an id already handled: nothing to do, and no second
      // verification, which is what keeps a retried notification harmless.
      return;
    }

    const orderId = await this.findOrder(schemaName, reference ?? merchantRef, sessionId, merchantRef);
    if (orderId !== null && reference !== null && /^(cep|oxxopay)\./.test(eventType)) {
      // The buyer picked cash on the hosted page, or the reference was just
      // announced: remember it so the payment can be matched and shown.
      await this.orders.attachCashReferenceInSchema(schemaName, orderId, reference, null);
    }

    if (transactionId === null) {
      await this.markProcessed(schemaName, eventId, 'IGNORED_NO_TRANSACTION');
      return;
    }
    if (orderId === null) {
      await this.markProcessed(schemaName, eventId, 'UNKNOWN_ORDER');
      return;
    }
    if (eventType === 'cep.created') {
      // A reference was created; there is no payment to verify yet.
      await this.markProcessed(schemaName, eventId, 'REFERENCE_CREATED');
      return;
    }

    try {
      const result = await this.orders.verifyOrderInSchema(schemaName, orderId, transactionId, tenantId);
      await this.markProcessed(schemaName, eventId, result.status);
    } catch {
      // Verification failing leaves the order unconfirmed. It is never promoted
      // to paid on the strength of the notification.
      this.logger.error(`Verification failed for a ${eventType} notification.`);
      await this.markProcessed(schemaName, eventId, 'VERIFICATION_FAILED');
    }
  }

  /**
   * Resolves the tenant and schema behind an opaque webhook token.
   *
   * @param token Token from the URL.
   * @returns The route, or `null` when unknown or revoked.
   */
  private async resolve(token: string): Promise<ResolvedWebhookRoute | null> {
    const config = await this.config.resolveByWebhookToken(token);
    if (config === null) {
      return null;
    }
    return { tenantId: config.tenantId, schemaName: config.schemaName };
  }

  /**
   * Persists a notification, treating a repeated id as a no-op.
   *
   * @param schemaName Tenant schema.
   * @param eventId Event id.
   * @param eventType Netpay event name.
   * @param transactionId Transaction, when present.
   * @param payload Raw payload.
   * @returns `true` when stored, `false` on a duplicate.
   */
  private async recordEvent(
    schemaName: string,
    eventId: string,
    eventType: string,
    transactionId: string | null,
    payload: InboundNetpayEvent,
  ): Promise<boolean> {
    const sanitized: Record<string, unknown> = {};
    for (const field of RETAINED_EVENT_FIELDS) {
      const value = payload.data?.[field];
      if (value !== undefined) {
        sanitized[field] = value;
      }
    }
    try {
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentWebhookEvent.create({
          data: {
            eventId,
            eventType,
            netpayTransactionId: transactionId,
            payloadSanitized: sanitized as never,
          },
        }),
      );
      return true;
    } catch (error) {
      // Only a repeat of an id already stored means "already handled". Anything
      // else is a real failure: swallowing it would skip the verification
      // silently and the payment would never settle.
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Records the outcome on a stored notification.
   *
   * @param schemaName Tenant schema.
   * @param eventId Event id.
   * @param outcome Short outcome label.
   */
  private async markProcessed(schemaName: string, eventId: string, outcome: string): Promise<void> {
    try {
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentWebhookEvent.updateMany({
          where: { eventId },
          data: { processedAt: new Date(), outcome },
        }),
      );
    } catch {
      this.logger.error(`Could not record the outcome of notification ${eventId}.`);
    }
  }

  /**
   * Finds the order a notification refers to.
   *
   * @param schemaName Tenant schema.
   * @param reference Order reference, when present.
   * @param sessionId Checkout Hosted session id, when present.
   * @returns The order id, or `null` when the reference is absent or unknown.
   */
  private async findOrder(
    schemaName: string,
    reference: string | null,
    sessionId: string | null,
    merchantRef: string | null = null,
  ): Promise<string | null> {
    const keys: (
      { orderReference: string } | { checkoutSessionId: string } | { paymentReference: string }
    )[] = [];
    if (reference !== null) {
      keys.push({ orderReference: reference });
      // A cash reference identifies the order too, once it has been attached.
      keys.push({ paymentReference: reference });
    }
    if (merchantRef !== null && merchantRef !== reference) {
      keys.push({ orderReference: merchantRef });
    }
    if (sessionId !== null) {
      keys.push({ checkoutSessionId: sessionId });
    }
    if (keys.length === 0) {
      return null;
    }
    const row = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.findFirst({
        where: { OR: keys },
        select: { id: true },
      }),
    );
    if (row === null) {
      return null;
    }
    // The transaction is deliberately NOT bound to the order here. The
    // notification is unsigned, so the id it carries proves nothing, and binding
    // on first sight would let anyone holding the webhook URL pin an order to a
    // transaction that does not exist: the real notification would then be refused
    // as "already bound to a different transaction" and the order could never
    // settle. Verification binds the id only after the provider has confirmed it.
    return row.id;
  }
}
