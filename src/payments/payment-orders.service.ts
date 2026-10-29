import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient as TenantClient } from '../generated/tenant-plane/client';
import type { PaymentStatus } from '../generated/tenant-plane/enums';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { DEFAULT_ALLOWED_CURRENCIES, PaymentConfigService } from './payment-config.service';
import { NetpayClient, NetpayRequestError } from './netpay.client';
import {
  FAILED_STATUSES,
  MAX_CARDS_PER_CLIENT,
  SETTLED_STATUSES,
  msiRejection,
  NETPAY_CARD_TOKEN_PATTERN,
  netpayText,
  parseStatus,
  toAmountString,
  type NetpayAddress,
  type NetpayChargeBody,
  type NetpayOxxoReference,
  type NetpayClientCard,
  type NetpayEnvironment,
  type NetpayThreeDSecure,
  type NetpayTransaction,
} from './netpay-endpoints';
import { PAYMENT_EVENTS, PaymentEvents, eventForTransition, type PaymentEventType } from './payment-events';
import { paymentUrls } from '../config/payment-urls';
import {
  ConflictException,
  CurrencyNotEnabledException,
  NotFoundException,
  OrderStateConflictException,
  ProviderResultPendingException,
  ReturnUrlNotAllowedException,
  ValidationException,
  isProviderOutcomeUnknown,
} from '../common/errors/app.exception';
import { quoteIdentifier } from '../prisma/identifiers';
import { classifyDecline, type DeclineCode } from './decline-codes';
import { AuditLogService } from '../audit/audit-log.service';
import { PaymentQuickLinksService, type QuickLinkRef } from './payment-quick-links.service';
import { auditActorOf } from '../audit/audit-actor';
import { logPaymentStatusChange } from '../common/logging/payment-log-events';

/** What a caller sees about an order. Never contains a provider credential. */
export interface PaymentOrderView {
  readonly id: string;
  readonly orderReference: string;
  readonly merchantReferenceCode: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly netpayTransactionId: string | null;
  /** How the buyer paid: `CARD` or `OXXO`. Null until Netpay says. */
  readonly paymentMethod: string | null;
  /** Cash reference (OXXO Pay) the buyer takes to a store. */
  readonly paymentReference: string | null;
  readonly paymentReferenceExpiresAt: string | null;
  /** Total already returned to the buyer. */
  readonly refundedAmount: string;
  /**
   * Everything a storefront needs to open the Netpay checkout, and nothing more.
   *
   * Deliberately excludes the provider secret: only the public key travels to a
   * browser. The amount travels as a token, so the figure the buyer sees cannot
   * become the figure that is charged.
   */
  readonly checkout: {
    readonly mode: CheckoutMode;
    readonly environment: 'SANDBOX' | 'LIVE';
    readonly publicKey: string;
    readonly amountToken: string | null;
    /** Where to send the buyer, for `hosted`; Netpay hosts the payment page. */
    readonly hostedCheckoutUrl: string | null;
    readonly merchantReferenceCode: string;
    readonly amount: string;
    readonly currency: string;
    readonly sandboxMode: boolean;
    readonly redirectUrl: string;
    readonly cancelUrl: string;
  } | null;
  readonly failureReason: string | null;
  /** Stable decline code (BN-REQ-PAY-006) when the order failed; `null` otherwise. */
  readonly failureCode: string | null;
  /** Amount Netpay reported at the last successful verification (BN-REQ-REC-006). */
  readonly verifiedAmount: string | null;
  /**
   * When Netpay reported a payment for this order after it was CANCELLED or EXPIRED
   * (BN-REQ-PAY-004). The status stays; the merchant refunds.
   */
  readonly paidAfterCancelAt: string | null;
  /** Quick link público creado con la orden (`quickLink: true`); sólo en la respuesta de creación. */
  readonly quickLink?: { readonly code: string; readonly url: string } | null;
  /** Charge attempts (BN-REQ-PAY-001), on `GET /t/payments/orders/:id` only. */
  readonly attempts?: { readonly count: number; readonly items: readonly PaymentAttemptView[] };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One charge attempt, as a consumer sees it. */
export interface PaymentAttemptView {
  readonly attemptNo: number;
  /** SUBMITTED, UNKNOWN, FAILED, PAID, AMOUNT_MISMATCH, ABANDONED or UNRESOLVED. */
  readonly status: string;
  readonly declineCode: string | null;
  readonly netpayTransactionId: string | null;
  readonly createdAt: string;
}

/** A page of {@link PaymentOrdersService.list} (BN-REQ-REC-005). */
export interface PaymentOrderPage {
  readonly items: PaymentOrderView[];
  /** Opaque; pass it as `cursor` for the next page. `null` on the last page. */
  readonly nextCursor: string | null;
}

/** Filters of {@link PaymentOrdersService.list}. */
export interface PaymentOrderQuery {
  /** Page size, 1-100 (default 25). */
  readonly limit?: number;
  /** From a previous page's `nextCursor`. */
  readonly cursor?: string;
  /** Only orders changed at or after this instant; pages oldest change first. */
  readonly updatedSince?: Date;
  /** Only these statuses. */
  readonly status?: readonly string[];
  readonly merchantReferenceCode?: string;
}

/** Position in a listing, carried by the opaque cursor. */
export interface OrderCursor {
  readonly direction: 'asc' | 'desc';
  readonly updatedAt: Date;
  readonly id: string;
}

/**
 * Encodes a listing position as an opaque cursor (base64url JSON). Opaque by
 * contract: consumers pass it back unchanged and never build one.
 *
 * @param cursor Position.
 * @returns The cursor string.
 */
export function encodeOrderCursor(cursor: OrderCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, d: cursor.direction, u: cursor.updatedAt.toISOString(), i: cursor.id }),
  ).toString('base64url');
}

/**
 * Decodes a cursor from {@link encodeOrderCursor}.
 *
 * @param raw Cursor as received.
 * @returns The position.
 * @throws {ValidationException} When it is not one this API issued.
 */
export function decodeOrderCursor(raw: string): OrderCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) {
      throw new Error('shape');
    }
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    const updatedAt = new Date(typeof value['u'] === 'string' ? value['u'] : '');
    if (
      value['v'] !== 1 ||
      (value['d'] !== 'asc' && value['d'] !== 'desc') ||
      Number.isNaN(updatedAt.getTime()) ||
      typeof value['i'] !== 'string' ||
      value['i'].length > 64
    ) {
      throw new Error('fields');
    }
    return { direction: value['d'], updatedAt, id: value['i'] };
  } catch {
    throw new ValidationException('cursor is not valid; pass nextCursor from a previous page unchanged.');
  }
}

/** Every order status, for validating a `status` filter. */
const ORDER_STATUS_VALUES: readonly PaymentStatus[] = [
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
];

/** What reconciliation did to one order (BN-REQ-REC-001…004). */
export interface ReconcileOrderOutcome {
  readonly from: string;
  readonly to: string;
  /** Whether the order changed (its status, or a late payment was recorded). */
  readonly corrected: boolean;
  /** `verified`, `expired`, `refund_completed`, `charge_unknown_reset`, `paid_after_cancel`, `unchanged`, `skipped`. */
  readonly action: string;
}

/** What reconciliation passes to {@link PaymentOrdersService.reconcileOrder}. */
export interface ReconcileOrderContext {
  readonly now: Date;
  /** Awaited before each call to Netpay: the per-tenant rate limit. */
  readonly beforeProviderCall: () => Promise<void>;
  /** WAIT_THREEDS for longer than this expires the order (BN-REQ-REC-002). */
  readonly threeDsTimeoutMs: number;
  /** CHARGE_UNKNOWN with no transaction for longer than this returns to PENDING. */
  readonly chargeUnknownGraceMs: number;
  /** A cash reference this long past its expiry, still unpaid, expires the order. */
  readonly referenceGraceMs: number;
}

/** An order row as {@link PaymentOrdersService} selects it. */
type OrderRow = {
  id: string;
  sequence: number;
  orderReference: string;
  merchantReferenceCode: string;
  amount: Prisma.Decimal;
  currency: string;
  status: PaymentStatus;
  netpayTransactionId: string | null;
  amountToken: string | null;
  failureReason: string | null;
  failureCode: string | null;
  checkoutMode: string;
  paymentMethod: string | null;
  paymentReference: string | null;
  paymentReferenceExpiresAt: Date | null;
  refundedAmount: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
  /** Configuration version the order was created with (BN-REQ-CFG-002). */
  configId?: string | null;
  verifiedAmount?: Prisma.Decimal | null;
  paidAfterCancelAt?: Date | null;
};

/**
 * A committed (or about to be committed) status change of an order. `latePayment`
 * marks a payment recorded on a CANCELLED or EXPIRED order (BN-REQ-PAY-004).
 */
type StatusChange = {
  row: OrderRow;
  previousStatus: string;
  emittedEvent: PaymentEventType | null;
  latePayment?: boolean;
};

/**
 * Thrown inside a status change whose order is no longer in a status the change
 * applies to; rolls the transaction back and turns the change into a no-op.
 */
class StaleTransitionError extends Error {
  constructor(readonly current: string) {
    super(`The order moved to ${current} meanwhile.`);
  }
}

/** What a status change writes besides the order row. */
interface StatusChangeOptions {
  readonly tenantId: string;
  /** Emitted whatever the transition, e.g. every refund. */
  readonly event?: PaymentEventType;
  /** Amount of this refund, carried by `payment.refunded`. */
  readonly refunded?: Prisma.Decimal;
  /** The charge attempt this change creates or concludes. */
  readonly attempt?: AttemptChange;
  /** Further writes that must commit with the change. */
  readonly also?: (client: TenantClient) => Promise<void>;
  /**
   * Statuses the order must still be in, read under its row lock. Otherwise the
   * change is dropped (a concurrent request, webhook or worker got there first).
   */
  readonly expectFrom?: readonly PaymentStatus[];
  /** What caused it, for the log and the audit: `api`, `webhook`, `reconciliation`. */
  readonly source?: string;
}

/** Result of verifying one order against Netpay. */
export interface VerificationResult {
  readonly orderId: string;
  readonly status: string;
  readonly changed: boolean;
  readonly emittedEvent: string | null;
}

/**
 * What a charge returns to the storefront.
 *
 * Deliberately not the provider's answer: Netpay echoes the request, which
 * includes the CVV and the card details.
 */
export interface ChargeResult {
  readonly transactionTokenId: string | null;
  /** The provider's word for the charge: `success`, or `review` when 3-D Secure is needed. */
  readonly status: string | null;
  readonly amount: number | string | null;
  readonly currency: string;
  /** Where the order stands after the provider was asked about the charge. */
  readonly orderStatus: string;
  /** Present when the issuer wants the buyer to authenticate. */
  readonly threeDSecureResponse?: NetpayThreeDSecure;
  /** Netpay's reason when the charge was declined, for the storefront to show. */
  readonly declineReason?: string;
  /** Stable decline code (BN-REQ-PAY-006), present when the charge was declined. */
  readonly failureCode?: DeclineCode;
}

/**
 * How the buyer pays.
 *
 *  * `hosted` — Netpay hosts the payment page; the buyer is redirected to it.
 *  * `plus` — the storefront renders Netpay's button, carrying a server-issued amount token.
 *  * `custom` — the storefront tokenises the card and this system charges the token.
 */
export type CheckoutMode = 'hosted' | 'plus' | 'custom' | 'oxxo';

/** Buyer details a cash reference needs. */
export interface OxxoBuyer {
  readonly name: string;
  readonly email: string;
  readonly phone?: string;
}

/** How long an operation claim holds before it is treated as abandoned. */
const CLAIM_WINDOW_MS = 2 * 60_000;

/** Internal status meaning the order is settled and may be fulfilled. */
const STATUS_PAID = 'PAID' satisfies PaymentStatus;

/** Part of a settled charge went back to the buyer (BN-REQ-PAY-005). */
const STATUS_PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED' satisfies PaymentStatus;

/** The whole charge went back to the buyer. */
const STATUS_REFUNDED = 'REFUNDED' satisfies PaymentStatus;

/**
 * Statuses in which money moved and the provider has nothing left to decide.
 * Verifying, charging or confirming such an order is refused or a no-op.
 */
const SETTLED_ORDER_STATUSES: readonly PaymentStatus[] = [
  STATUS_PAID,
  STATUS_PARTIALLY_REFUNDED,
  STATUS_REFUNDED,
];

/** Statuses from which a refund (of what is left) is possible. */
const REFUNDABLE_STATUSES: readonly PaymentStatus[] = [STATUS_PAID, STATUS_PARTIALLY_REFUNDED];

/**
 * A charge was sent and Netpay gave no definitive answer (BN-REQ-PAY-003): the buyer
 * may have been charged, so no new charge is accepted until a verification resolves it.
 */
const STATUS_CHARGE_UNKNOWN = 'CHARGE_UNKNOWN' satisfies PaymentStatus;

/**
 * Statuses a charge may start from. `FAILED` is one of them: a definitive decline
 * accepts a new attempt with another card (BN-REQ-PAY-001). An order with a
 * previous attempt still bound and not declined is verified with Netpay first
 * (BN-REQ-PAY-002).
 */
const CHARGEABLE_STATUSES: readonly PaymentStatus[] = ['PENDING', 'PENDING_VERIFICATION', 'FAILED'];

/** Withdrawn before payment (BN-REQ-PAY-004). */
const STATUS_CANCELLED = 'CANCELLED' satisfies PaymentStatus;

/** Never paid in time (BN-REQ-REC-002/003). */
const STATUS_EXPIRED = 'EXPIRED' satisfies PaymentStatus;

/**
 * Terminal and unpaid. A payment Netpay reports afterwards does not reopen the
 * order: it is recorded as `paidAfterCancelAt` with `payment.paid_after_cancel`.
 */
const TERMINAL_UNPAID_STATUSES: readonly PaymentStatus[] = [STATUS_CANCELLED, STATUS_EXPIRED];

/** Statuses a cancellation may start from, once Netpay confirmed nothing was charged. */
const CANCELLABLE_STATUSES: readonly PaymentStatus[] = ['PENDING', 'PENDING_VERIFICATION', 'FAILED'];

/** Statuses reconciliation may expire. */
const EXPIRABLE_STATUSES: readonly PaymentStatus[] = ['PENDING', 'PENDING_VERIFICATION'];

/** Outcome of one charge attempt, as `payment_attempt.status` records it. */
const ATTEMPT = {
  /** Sent; Netpay answered without declining. The order's verification decides. */
  SUBMITTED: 'SUBMITTED',
  /** Sent; no definitive answer. The order is CHARGE_UNKNOWN. */
  UNKNOWN: 'UNKNOWN',
  FAILED: 'FAILED',
  PAID: 'PAID',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** A 3-D Secure challenge never confirmed, verified as not charged before the next attempt. */
  ABANDONED: 'ABANDONED',
  /**
   * A charge without a definitive answer that Netpay never named a transaction for;
   * reconciliation returned the order to PENDING after the grace period.
   */
  UNRESOLVED: 'UNRESOLVED',
} as const;

/** How many pending provider results one call applies at most. */
const PENDING_RESULTS_PER_RUN = 100;

/** A charge attempt to write with a status change. */
type AttemptChange =
  /** A new attempt, numbered after the last one of the order. */
  | {
      readonly kind: 'new';
      readonly transactionId: string | null;
      readonly status: string;
      readonly declineCode?: string | null;
      /** The order already had a transaction bound before attempts were recorded. */
      readonly legacyBound: boolean;
    }
  /** The verification of a transaction concluded: update the attempt that holds it. */
  | {
      readonly kind: 'settle';
      readonly transactionId: string;
      readonly status: string;
      readonly declineCode?: string | null;
    };

/** What a pending provider result carries (`pending_provider_result.providerPayload`). */
type PendingPayload =
  | {
      readonly kind: 'refund';
      readonly transactionId: string;
      readonly amount: string;
      /** `refundedAmount` before this refund: applying is a no-op when it already moved. */
      readonly refundedAmountBefore: string;
    }
  | {
      readonly kind: 'charge';
      /** `declined`, `submitted` (answered, not declined) or `unknown` (no answer). */
      readonly outcome: 'declined' | 'submitted' | 'unknown';
      readonly transactionId: string | null;
      readonly priorStatus: string;
      readonly legacyBound: boolean;
      readonly failureReason?: string | null;
      readonly failureCode?: string | null;
      readonly providerFailureCode?: string | null;
      /** The saved card's customer, when the charge stored the card. */
      readonly savedCustomerId?: string | null;
      readonly savedCardToken?: string | null;
    };

/** Provider statuses that mean money moved. Distinct from our own vocabulary. */
const PROVIDER_SETTLED = new Set<string>([...SETTLED_STATUSES]);

/**
 * Order lifecycle, and the one rule the rest of the system depends on.
 *
 * Netpay's inbound notification is unsigned, so it is never treated as evidence
 * that a payment happened. It only tells us to come and ask the API. Every
 * transition out of `PENDING*` happens in {@link verifyOrder}, against what
 * `GET /v3/transactions/{id}` returns.
 */
@Injectable()
export class PaymentOrdersService {
  private readonly logger = new Logger(PaymentOrdersService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly requestContext: RequestContextService,
    private readonly config: PaymentConfigService,
    private readonly netpay: NetpayClient,
    private readonly events: PaymentEvents,
    private readonly audit: AuditLogService,
    private readonly quickLinks: PaymentQuickLinksService,
  ) {}

  /**
   * Creates an order and a Checkout Hosted session.
   *
   * The amount arrives from the caller and becomes the source of truth: the
   * amount Netpay later reports is compared against this one, never used to
   * replace it.
   *
   * @param input Merchant reference and amount.
   * @returns The created order, including its checkout URL.
   */
  async create(input: {
    merchantReferenceCode: string;
    amount: string;
    currency?: string;
    /** `hosted` redirects the buyer to Netpay; `plus` renders its button; `custom` charges a token here. */
    checkoutMode?: CheckoutMode;
    /** Where Netpay sends the buyer after a successful hosted payment. */
    successUrl?: string;
    /** Where Netpay sends the buyer after a rejected hosted payment. */
    cancelUrl?: string;
    /** Requested installment count; Netpay only offers 3, 6, 9, 12 or 18. */
    installments?: number;
    /** Methods the hosted page offers: `card`, and/or `cep` (cash reference). Default `card`. */
    paymentMethods?: readonly ('card' | 'cep')[];
    /** Buyer for an `oxxo` order. Required for it, ignored otherwise. */
    buyer?: OxxoBuyer;
    /** Days the cash reference stays payable (1-30). Default 2. */
    expirationDays?: number;
    /** Genera un quick link público (`QUICK_LINK_BASE_URL/<code>`) y fija a él las URLs de retorno. Sólo `hosted`. */
    quickLink?: boolean;
  }): Promise<PaymentOrderView> {
    const amount = this.normaliseAmount(input.amount);
    if (amount === null) {
      throw new ValidationException('Amount must be a positive value with at most two decimals.');
    }
    if (input.installments !== undefined) {
      // Checked before the call: Netpay refuses an unavailable plan, and the
      // merchant should not have to decode a provider error to find that out.
      const rejection = msiRejection(input.installments, amount);
      if (rejection !== null) {
        throw new ValidationException(rejection);
      }
    }
    const checkoutMode = input.checkoutMode ?? 'hosted';
    if (
      (checkoutMode === 'hosted' || checkoutMode === 'oxxo') &&
      (input.currency ?? 'MXN').toUpperCase() !== 'MXN'
    ) {
      // Netpay documents the currency of a hosted session and of a cash reference as always MXN.
      throw new ValidationException('Checkout Hosted and cash references settle in MXN only.');
    }
    if (checkoutMode === 'oxxo' && input.buyer === undefined) {
      throw new ValidationException('A cash reference needs the buyer name and email.');
    }
    const config = await this.config.getUsable();
    const tenantId = this.currentTenantId();
    const currency = (input.currency ?? 'MXN').toUpperCase();
    // Only what the tenant is enabled for (BN-REQ-PAY-008): MXN unless configured.
    const allowedCurrencies = config.allowedCurrencies ?? DEFAULT_ALLOWED_CURRENCIES;
    if (!allowedCurrencies.includes(currency)) {
      throw new CurrencyNotEnabledException(currency, allowedCurrencies);
    }
    if (input.quickLink === true && checkoutMode !== 'hosted') {
      throw new ValidationException('A quick link needs the hosted checkout.');
    }
    if (input.quickLink === true && !this.quickLinks.enabled()) {
      // Despliegue mixto: un cliente nuevo contra un entorno sin QUICK_LINK_BASE_URL sigue creando
      // la orden (con el checkout alojado) y recibe `quickLink: null` en vez de un error.
      this.logger.warn({
        event: 'quick_link_disabled',
        message:
          'quickLink requested but QUICK_LINK_BASE_URL is not configured; creating the order without one',
        tenantId: this.currentTenantId(),
      });
    }
    // El quick link manda al comprador de vuelta a nuestro host, no al del tenant: no pasa por
    // allowedReturnOrigins, y gana sobre successUrl/cancelUrl del cuerpo.
    const quickLinkCode =
      input.quickLink === true && this.quickLinks.enabled() ? this.quickLinks.newCode() : null;
    const returnUrls = quickLinkCode === null ? null : this.quickLinks.returnUrls(quickLinkCode);
    if (checkoutMode === 'hosted' && returnUrls === null) {
      // Where Netpay sends the buyer back is a redirect this system vouches for
      // (BN-REQ-PAY-007). The configured defaults are trusted; a caller's are not.
      for (const [field, url] of [
        ['successUrl', input.successUrl],
        ['cancelUrl', input.cancelUrl],
      ] as const) {
        if (url !== undefined) {
          this.assertReturnUrl(field, url, config.allowedReturnOrigins ?? []);
        }
      }
    }
    const orderReference = PaymentConfigService.newOrderReference(config.orderReferencePrefix);

    const order = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.create({
        data: {
          tenantId,
          orderReference,
          merchantReferenceCode: input.merchantReferenceCode,
          amount: new Prisma.Decimal(amount),
          currency,
          status: 'PENDING',
          checkoutMode,
          configId: config.id,
        },
        select: this.orderSelect(),
      }),
    );
    await this.statusChanged(order.id, null, 'PENDING', tenantId, null);

    let amountToken: string | null = null;
    let hostedCheckoutUrl: string | null = null;
    let quickLink: QuickLinkRef | null = null;
    let cashReference: { reference: NetpayOxxoReference; expiresAt: Date } | null = null;
    try {
      if (checkoutMode === 'hosted') {
        // Netpay hosts the payment page and answers with its URL. The merchant
        // reference sent is the order reference, which is unique, so a retry can
        // never clash with an earlier session.
        const successUrl = returnUrls?.successUrl ?? input.successUrl ?? paymentUrls().redirectUrl;
        const cancelUrl = returnUrls?.cancelUrl ?? input.cancelUrl ?? paymentUrls().cancelUrl;
        const session = await this.netpay.createCheckoutSession(config.environment, config.secretKey, {
          paymentMethodTypes:
            input.paymentMethods !== undefined && input.paymentMethods.length > 0
              ? [...new Set(input.paymentMethods)]
              : ['card'],
          lineItems: [
            {
              name: netpayText(input.merchantReferenceCode).slice(0, 120) || orderReference,
              amount,
              quantity: '1',
              currency,
            },
          ],
          linkType: 'NETPAY_CHECKOUT',
          merchantRefCode: orderReference,
          ...(successUrl === undefined ? {} : { successUrl }),
          ...(cancelUrl === undefined ? {} : { cancelUrl }),
        });
        hostedCheckoutUrl = session.hostedCheckoutUrl;
        if (quickLinkCode !== null && hostedCheckoutUrl !== null) {
          quickLink = await this.quickLinks.register({
            code: quickLinkCode,
            tenantId,
            schemaName: this.requestContext.requireTenant().schemaName,
            orderId: order.id,
            hostedCheckoutUrl,
          });
        }
        // The notification names the payment only by this id.
        await this.tenantPrisma.forCurrentTenantTransaction((client) =>
          client.paymentOrder.update({
            where: { id: order.id },
            data: { checkoutSessionId: session.sessionId, updatedAt: new Date() },
          }),
        );
      } else if (checkoutMode === 'oxxo') {
        // A cash reference is created here, so the order knows it from the start. The
        // merchant reference sent is the order reference, which is how the
        // `oxxopay.paid` notification finds the order again.
        const buyer = input.buyer as OxxoBuyer;
        const days = Math.min(30, Math.max(1, Math.round(input.expirationDays ?? 2)));
        const reference = await this.netpay.createOxxoReference(config.environment, config.secretKey, {
          amount,
          currency: 'MXN',
          name: netpayText(buyer.name).slice(0, 120) || 'Customer',
          email: buyer.email,
          ...(buyer.phone === undefined || buyer.phone === '' ? {} : { phone: buyer.phone }),
          merchantReferenceCode: orderReference,
          oxxoPay: { expirationNumber: String(days), expirationType: 'DAY' },
        });
        const expiresAt = parseNetpayLocalDate(reference.oxxoPay?.expirationDate, days);
        cashReference = { reference, expiresAt };
        await this.tenantPrisma.forCurrentTenantTransaction((client) =>
          client.paymentOrder.update({
            where: { id: order.id },
            data: {
              paymentMethod: 'OXXO',
              paymentReference: reference.reference,
              paymentReferenceExpiresAt: expiresAt,
              updatedAt: new Date(),
            },
          }),
        );
      } else if (checkoutMode === 'plus') {
        // The amount is tokenised here, server-side. The storefront renders a
        // button carrying this token, so a buyer who edits the figure in the page
        // cannot change what Netpay charges: the provider settles the amount that
        // was fixed at this point.
        const tokenised = await this.netpay.tokenizeAmount(
          config.environment,
          config.secretKey,
          Number(amount),
        );
        amountToken = tokenised.tokenAmount;
        const bound = tokenised.amount.toFixed(2);
        if (bound !== amount) {
          // The provider bound a different figure than the order recorded. Refusing
          // is the only safe reading: the order amount is the source of truth.
          throw new ValidationException(
            `The provider bound ${bound} to the token while the order is ${amount}.`,
          );
        }
        await this.tenantPrisma.forCurrentTenantTransaction((client) =>
          client.paymentOrder.update({
            where: { id: order.id },
            data: { amountToken, updatedAt: new Date() },
          }),
        );
      }
    } catch (error) {
      // The order row stays: it is the record that a charge was attempted. It is
      // not marked paid, and nothing is delivered, so a retry is safe.
      await this.tenantPrisma.forCurrentTenantTransaction((client) =>
        client.paymentOrder.update({
          where: { id: order.id },
          data: { failureReason: 'Checkout session could not be created.', updatedAt: new Date() },
        }),
      );
      this.logger.error(`Failed to create a Netpay checkout session for order ${order.id}`);
      throw error;
    }

    return {
      ...this.toView({
        ...order,
        netpayTransactionId: null,
        amountToken,
        paymentMethod: cashReference === null ? null : 'OXXO',
        paymentReference: cashReference?.reference.reference ?? null,
        paymentReferenceExpiresAt: cashReference?.expiresAt ?? null,
        refundedAmount: new Prisma.Decimal(0),
      }),
      checkout: this.checkoutConfig(config, {
        orderReference,
        merchantReferenceCode: input.merchantReferenceCode,
        amount,
        currency,
        mode: checkoutMode,
        amountToken,
        hostedCheckoutUrl,
      }),
      quickLink,
    };
  }

  /**
   * Reads one order belonging to the current tenant.
   *
   * @param id Order id.
   * @returns The order.
   * @throws {NotFoundException} When it does not exist in this tenant.
   */
  async findById(id: string): Promise<PaymentOrderView> {
    const found = await this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      const row = await client.paymentOrder.findFirst({ where: { id }, select: this.orderSelect() });
      if (row === null) {
        return null;
      }
      const attempts = await client.paymentAttempt.findMany({
        where: { orderId: id },
        orderBy: { attemptNo: 'asc' },
        select: {
          attemptNo: true,
          status: true,
          declineCode: true,
          netpayTransactionId: true,
          createdAt: true,
        },
      });
      return { row, attempts };
    });
    if (found === null) {
      // Same answer as "exists but belongs to another tenant": confirming the
      // difference would be an existence oracle across tenants.
      throw new NotFoundException('The requested resource was not found.');
    }
    const quickLink = this.quickLinks.enabled()
      ? await this.quickLinks.findForOrder(this.currentTenantId(), id)
      : null;
    return {
      ...this.toView(found.row),
      quickLink,
      // What a consumer reconciles against (BN-REQ-REC-006): every attempt, in order.
      attempts: {
        count: found.attempts.length,
        items: found.attempts.map((a) => ({
          attemptNo: a.attemptNo,
          status: a.status,
          declineCode: a.declineCode,
          netpayTransactionId: a.netpayTransactionId,
          createdAt: a.createdAt.toISOString(),
        })),
      },
    };
  }

  /**
   * Lists orders for the current tenant, a page at a time (BN-REQ-REC-005).
   *
   * Keyset pagination on `(updatedAt, id)`, so a page never repeats or skips a row
   * because of an insert elsewhere. With `updatedSince` the listing runs oldest
   * change first, which is what an incremental sync wants: store the last
   * `updatedAt` seen and ask again from there. Without it, newest first. The
   * direction travels inside the cursor.
   *
   * @param query Page size, cursor and filters.
   * @returns The page and the cursor of the next one.
   * @throws {ValidationException} On a forged cursor or an unknown status.
   */
  async list(query: PaymentOrderQuery): Promise<PaymentOrderPage> {
    const take = Math.min(Math.max(Math.trunc(query.limit ?? 25) || 25, 1), 100);
    const cursor = query.cursor === undefined || query.cursor === '' ? null : decodeOrderCursor(query.cursor);
    const direction = cursor?.direction ?? (query.updatedSince === undefined ? 'desc' : 'asc');
    const statuses = query.status?.map((s) => s.trim().toUpperCase()).filter((s) => s !== '');
    const unknown = statuses?.find((s) => !(ORDER_STATUS_VALUES as readonly string[]).includes(s));
    if (unknown !== undefined) {
      throw new ValidationException(`status ${unknown} is not an order status.`);
    }
    const where: Prisma.PaymentOrderWhereInput = {
      ...(query.updatedSince === undefined ? {} : { updatedAt: { gte: query.updatedSince } }),
      ...(statuses === undefined || statuses.length === 0
        ? {}
        : { status: { in: statuses as PaymentStatus[] } }),
      ...(query.merchantReferenceCode === undefined
        ? {}
        : { merchantReferenceCode: query.merchantReferenceCode }),
    };
    if (cursor !== null) {
      const after = direction === 'asc' ? 'gt' : 'lt';
      where.AND = [
        {
          OR: [
            { updatedAt: { [after]: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, id: { [after]: cursor.id } },
          ],
        },
      ];
    }
    const rows = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findMany({
        where,
        orderBy: [{ updatedAt: direction }, { id: direction }],
        take: take + 1,
        select: this.orderSelect(),
      }),
    );
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    // The code is what an agent reads and shares; the listing carries it like the detail does.
    const quickLinks = this.quickLinks.enabled()
      ? await this.quickLinks.findForOrders(
          this.currentTenantId(),
          page.map((row) => row.id),
        )
      : new Map<string, QuickLinkRef>();
    return {
      items: page.map((row) => ({ ...this.toView(row), quickLink: quickLinks.get(row.id) ?? null })),
      nextCursor:
        rows.length > take && last !== undefined
          ? encodeOrderCursor({ direction, updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  }

  /**
   * Verifies an order against Netpay and applies the result.
   *
   * Safe to call repeatedly: a transaction already reflected is a no-op, so a
   * redelivered notification or a retried verification cannot double-apply.
   *
   * @param orderId Order to verify.
   * @param transactionId Transaction to ask Netpay about.
   * @returns What the verification concluded.
   */
  async verifyOrder(orderId: string, transactionId: string): Promise<VerificationResult> {
    return this.verifyOrderInSchema(
      this.tenantPrisma.requireCurrentSchema(),
      orderId,
      transactionId,
      this.currentTenantId(),
    );
  }

  /**
   * Verifies an order against Netpay from outside a tenant request.
   *
   * The inbound notification arrives on a public route that never resolved a
   * tenant, so the schema and tenant are passed explicitly rather than read from
   * the request context.
   *
   * @param schemaName Schema holding the order.
   * @param orderId Order to verify.
   * @param transactionId Transaction to ask Netpay about.
   * @param tenantId Tenant that owns the order.
   * @returns What the verification concluded.
   */
  async verifyOrderInSchema(
    schemaName: string,
    orderId: string,
    transactionId: string,
    tenantId: string,
  ): Promise<VerificationResult> {
    const existing = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.findFirst({ where: { id: orderId }, select: this.orderSelect() }),
    );
    if (existing === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    if (existing.netpayTransactionId !== null && existing.netpayTransactionId !== transactionId) {
      throw new ConflictException('This order is already bound to a different transaction.');
    }
    if (SETTLED_ORDER_STATUSES.includes(existing.status)) {
      // Already settled. Re-verifying a paid (or refunded) order must be a no-op:
      // otherwise a redelivered notification rewrites the row and bumps its
      // sequence, and a refunded transaction, which Netpay no longer reports as
      // settled, would drag the order back to PENDING_VERIFICATION.
      return { orderId, status: existing.status, changed: false, emittedEvent: null };
    }
    if (TERMINAL_UNPAID_STATUSES.includes(existing.status) && (existing.paidAfterCancelAt ?? null) !== null) {
      // A late payment already recorded: nothing left to learn.
      return { orderId, status: existing.status, changed: false, emittedEvent: null };
    }

    // The configuration the order was created with, not the tenant's current one
    // (BN-REQ-CFG-002): a SANDBOX order is verified with SANDBOX keys after a move to LIVE.
    const config = await this.config.getUsableInSchema(schemaName, existing.configId ?? null);
    const transaction = await this.netpay.getTransaction(config.environment, config.secretKey, transactionId);
    return this.applyVerification(schemaName, existing, transactionId, transaction, tenantId);
  }

  /**
   * Applies what Netpay reported about a transaction to its order.
   *
   * @param schemaName Tenant schema.
   * @param existing The order as read before asking Netpay.
   * @param transactionId Transaction asked about.
   * @param transaction Netpay's answer.
   * @param tenantId Tenant that owns the order.
   * @returns What the verification concluded.
   */
  private async applyVerification(
    schemaName: string,
    existing: OrderRow,
    transactionId: string,
    transaction: NetpayTransaction,
    tenantId: string,
    source?: string,
  ): Promise<VerificationResult> {
    const orderId = existing.id;
    // A transaction names the order it was charged for (`merchantReferenceCode` is the
    // order reference this system sent). The id reaches us from an unsigned notification
    // or from a buyer's browser, so without this check someone could attach a different,
    // genuinely paid transaction of the same amount to this order and have it settled.
    if (
      typeof transaction.merchantReferenceCode === 'string' &&
      transaction.merchantReferenceCode !== '' &&
      transaction.merchantReferenceCode !== existing.orderReference
    ) {
      this.logger.warn(
        `Transaction ${transactionId} belongs to another order; refusing to bind it to ${existing.id}.`,
      );
      throw new ConflictException('The transaction was charged for a different order.');
    }
    // One transaction settles one order. Without this a genuine paid transaction could
    // be replayed against a second order of the same amount; the partial unique index
    // of tenant migration 0022 enforces the same rule in the database.
    const boundElsewhere = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.findFirst({
        where: { netpayTransactionId: transactionId, id: { not: orderId } },
        select: { id: true },
      }),
    );
    if (boundElsewhere !== null && boundElsewhere.id !== orderId) {
      this.logger.warn(
        `Transaction ${transactionId} is already bound to another order; refusing ${orderId}.`,
      );
      throw new ConflictException('The transaction is already bound to a different order.');
    }

    const expected = existing.amount.toFixed(2);
    const reported = toAmountString(transaction.amount);
    const status = parseStatus(transaction.status);
    const now = new Date();

    if (reported !== null && reported !== expected) {
      // Never marked paid on a mismatch, whatever Netpay's status says.
      const updated = await this.applyStatus(
        schemaName,
        existing.id,
        'AMOUNT_MISMATCH',
        now,
        {
          netpayTransactionId: transactionId,
          verifiedAmount: new Prisma.Decimal(reported),
          failureReason: 'Amount reported by the provider does not match the order.',
        },
        { tenantId, source, attempt: { kind: 'settle', transactionId, status: ATTEMPT.AMOUNT_MISMATCH } },
      );
      return {
        orderId,
        status: updated.row.status,
        changed: updated.row.status !== updated.previousStatus,
        emittedEvent: updated.emittedEvent,
      };
    }

    // Fail closed: a settlement is only believed when Netpay names this order and
    // the amount. Either one missing proves nothing, so the order is not paid; it
    // stays under verification with the reason recorded, for reconciliation or a
    // person to settle.
    const unprovenSettlement =
      status !== null &&
      PROVIDER_SETTLED.has(status) &&
      (transaction.merchantReferenceCode !== existing.orderReference || reported === null);
    if (unprovenSettlement) {
      this.logger.warn(
        `Transaction ${transactionId} reported ${status} without naming order ${existing.id} and its amount; not settling it.`,
      );
    }

    if (status !== null && PROVIDER_SETTLED.has(status) && !unprovenSettlement) {
      const updated = await this.applyStatus(
        schemaName,
        existing.id,
        STATUS_PAID,
        now,
        {
          netpayTransactionId: transactionId,
          verifiedAmount: reported === null ? null : new Prisma.Decimal(reported),
          lastVerifiedAt: now,
          // Cash when the order carries a cash reference, card otherwise.
          paymentMethod:
            existing.paymentReference !== null || existing.checkoutMode === 'oxxo' ? 'OXXO' : 'CARD',
          failureReason: null,
          failureCode: null,
          providerFailureCode: null,
          // Settled: whatever operation was holding the claim is over, and this is
          // the statement that says so.
          operationClaim: null,
          operationClaimedAt: null,
        },
        // On a CANCELLED or EXPIRED order this records a late payment instead
        // (applyStatusIn): the status stays, `payment.paid_after_cancel` is emitted.
        { tenantId, source, attempt: { kind: 'settle', transactionId, status: ATTEMPT.PAID } },
      );
      return {
        orderId,
        status: updated.row.status,
        changed: updated.row.status !== updated.previousStatus || updated.latePayment === true,
        emittedEvent: updated.emittedEvent,
      };
    }

    if (status !== null && FAILED_STATUSES.includes(status)) {
      const decline = classifyDecline({ code: transaction.responseCode, message: transaction.responseMsg });
      const updated = await this.applyStatus(
        schemaName,
        existing.id,
        'FAILED',
        now,
        {
          netpayTransactionId: transactionId,
          lastVerifiedAt: now,
          failureReason: 'The provider reported the charge as unsuccessful.',
          failureCode: decline.failureCode,
          providerFailureCode: decline.providerCode,
          // Terminal as well, so the claim goes with it. The branch below
          // (PENDING_VERIFICATION) concludes nothing and deliberately keeps it.
          operationClaim: null,
          operationClaimedAt: null,
        },
        {
          tenantId,
          source,
          attempt: {
            kind: 'settle',
            transactionId,
            status: ATTEMPT.FAILED,
            declineCode: decline.failureCode,
          },
        },
      );
      return {
        orderId,
        status: updated.row.status,
        changed: updated.row.status !== updated.previousStatus,
        emittedEvent: updated.emittedEvent,
      };
    }

    // `IN_PROCESS`, a status we do not recognise, or a settlement Netpay did not
    // tie to this order and amount: nothing is concluded.
    const updated = await this.applyStatus(
      schemaName,
      existing.id,
      'PENDING_VERIFICATION',
      now,
      {
        netpayTransactionId: transactionId,
        lastVerifiedAt: now,
        ...(unprovenSettlement
          ? {
              failureReason:
                'The provider reported the charge as settled without naming this order and its amount; it needs a manual verification.',
            }
          : {}),
      },
      // A CHARGE_UNKNOWN attempt learns its transaction here; it is still undecided.
      { tenantId, source, attempt: { kind: 'settle', transactionId, status: ATTEMPT.SUBMITTED } },
    );
    return { orderId, status: updated.row.status, changed: false, emittedEvent: null };
  }

  /**
   * Stores a buyer's card with the provider.
   *
   * Only the returned token is kept here. The card number and CVV never reach
   * this process, so neither the database nor a log ever holds them.
   *
   * @param input Profile details and the optional card token.
   * @returns The profile id and the token to use for later charges.
   */
  async storeCard(input: {
    identifier: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cardToken?: string;
  }): Promise<{ netpayCustomerId: string; cardToken: string | null; lastFourDigits: string | null }> {
    if (input.cardToken !== undefined && !NETPAY_CARD_TOKEN_PATTERN.test(input.cardToken)) {
      throw new ValidationException('cardToken must be a Netpay token, not card data.');
    }
    const config = await this.config.getUsable();
    const profile = await this.netpay.createClient(config.environment, config.secretKey, {
      firstName: netpayText(input.firstName),
      lastName: netpayText(input.lastName),
      phone: input.phone,
      email: input.email,
      identifier: netpayText(input.identifier),
      ...(input.cardToken === undefined
        ? {}
        : { paymentSource: { type: 'card' as const, source: input.cardToken } }),
    });
    const stored = (profile.paymentSources ?? []).filter(
      (card): card is { source: string; type: string; defaultCard?: number } => card !== null,
    );
    const primary = stored[0];
    const lastFourDigits =
      primary === undefined ? null : await this.lastFourDigitsOf(config, profile.id, primary);
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentCustomer.upsert({
        where: { netpayCustomerId: profile.id },
        update: { userId: null, updatedAt: new Date() },
        create: {
          tenantId: this.currentTenantId(),
          netpayCustomerId: profile.id,
          defaultTokenId: primary?.source ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    );
    return {
      netpayCustomerId: profile.id,
      cardToken: primary?.source ?? null,
      // Only the last four digits, which is what a receipt legitimately needs, and
      // only as Netpay reports them: the token's tail is not the card's (BN-REQ-PAY-010).
      lastFourDigits,
    };
  }

  /**
   * Reads the real last four digits of a stored card from Netpay.
   *
   * The create answer may already carry them; otherwise the customer is read back.
   * A failure to read them never fails storing the card: the digits are then `null`.
   *
   * @param config Tenant provider configuration.
   * @param clientId Netpay customer id.
   * @param card The stored card from the create answer.
   * @returns Four digits, or `null` when Netpay does not say.
   */
  private async lastFourDigitsOf(
    config: { environment: NetpayEnvironment; secretKey: string },
    clientId: string,
    card: { source: string; card?: { lastFourDigits?: string } },
  ): Promise<string | null> {
    const fourDigits = (value: unknown): string | null =>
      typeof value === 'string' && /^\d{4}$/.test(value) ? value : null;
    const inline = fourDigits(card.card?.lastFourDigits);
    if (inline !== null) {
      return inline;
    }
    try {
      const info = await this.netpay.getClient(config.environment, config.secretKey, clientId);
      const match = (info.paymentSources ?? []).find((source) => source?.source === card.source);
      return fourDigits(match?.card?.lastFourDigits);
    } catch {
      this.logger.warn('Could not read the stored card digits back from Netpay.');
      return null;
    }
  }

  /**
   * Requires a Netpay customer id to belong to the current tenant (BN-REQ-PAY-012).
   *
   * Netpay scopes customers to the merchant account, not to a tenant of this system,
   * and a caller-supplied id must not reach another buyer's cards. The answer for a
   * foreign id is the same 404 as for an unknown one.
   *
   * @param clientId Netpay customer id.
   * @throws {NotFoundException} When the tenant has no such customer.
   */
  private async assertOwnCustomer(clientId: string): Promise<void> {
    const owned = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentCustomer.findFirst({
        where: { netpayCustomerId: clientId, tenantId: this.currentTenantId() },
        select: { id: true },
      }),
    );
    if (owned === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
  }

  /**
   * Charges a tokenized card against an existing order.
   *
   * This is the Checkout Custom path, and the only one where the buyer never
   * leaves the storefront. No card data reaches this process: the caller supplies
   * the token that client-side tokenisation produced.
   *
   * @param orderId Order to charge.
   * @param input Token plus the billing data Netpay requires.
   * @returns The transaction as Netpay reports it.
   */
  async chargeToken(
    orderId: string,
    input: {
      cardToken: string;
      billing: {
        firstName: string;
        lastName: string;
        email: string;
        phone: string;
        address: NetpayAddress;
      };
      saveCard?: boolean;
      installments?: number;
      /** An existing Netpay customer whose stored card `cardToken` is. */
      clientId?: string;
      /** The buyer's own id in this system; the order reference is used when absent. */
      buyerIdentifier?: string;
      /** Fingerprint produced by the browser during tokenisation; also the session id. */
      deviceFingerPrint: string;
      /** Device details produced by the browser during tokenisation. */
      deviceInformation: Record<string, string>;
      /**
       * Security code, required when `clientId` names a stored card. It is forwarded
       * to Netpay and never stored, logged or returned.
       */
      cvv?: string;
      /** `referenceId` from `netpay3ds.config()`; the order reference when absent. */
      referenceId?: string;
      /** The buyer's `navigator.userAgent`, which Netpay documents as the value to send. */
      userAgent?: string;
      /** Card brand reported at tokenisation, used to enforce the 18-installment rule. */
      cardBrand?: string;
    },
  ): Promise<ChargeResult> {
    // Defence in depth: the DTO already rejects this shape, but a card number
    // must never reach `source` even if the DTO is bypassed. Sending one would
    // put card data in a request body and in the provider's logs.
    if (!NETPAY_CARD_TOKEN_PATTERN.test(input.cardToken)) {
      throw new ValidationException('cardToken must be a Netpay token, not card data.');
    }
    this.assertDeviceData(input.deviceFingerPrint, input.deviceInformation);
    if (input.clientId !== undefined) {
      // Netpay: a stored card is charged with `saveCard` false and the security
      // code every time, because the stored token does not carry it.
      if (input.saveCard === true) {
        throw new ValidationException('A stored card is charged with saveCard false.');
      }
      if (input.cvv === undefined || !/^\d{3,4}$/.test(input.cvv)) {
        throw new ValidationException('A stored card needs its cvv on every charge.');
      }
    } else if (input.cvv !== undefined) {
      // A one-time token already carries the code from tokenisation. Accepting it
      // here would only widen the set of requests that handle a CVV.
      throw new ValidationException('cvv is only accepted when charging a stored card (clientId).');
    }
    if (input.clientId !== undefined) {
      await this.assertOwnCustomer(input.clientId);
    }
    const existing = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findFirst({ where: { id: orderId }, select: this.orderSelect() }),
    );
    if (existing === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    if (SETTLED_ORDER_STATUSES.includes(existing.status)) {
      throw new OrderStateConflictException('This order is already settled.', { status: existing.status });
    }
    if (existing.status === STATUS_CHARGE_UNKNOWN) {
      // A previous charge got no definitive answer: the buyer may have been charged.
      throw new OrderStateConflictException(
        'A previous charge of this order got no definitive answer from Netpay; verify the order before charging again.',
        { status: existing.status },
      );
    }
    if (!CHARGEABLE_STATUSES.includes(existing.status)) {
      throw new OrderStateConflictException(`An order in ${existing.status} cannot be charged.`, {
        status: existing.status,
      });
    }
    const amount = existing.amount.toFixed(2);
    if (input.installments !== undefined) {
      const rejection = msiRejection(input.installments, amount, input.cardBrand);
      if (rejection !== null) {
        throw new ValidationException(rejection);
      }
    }
    const config = await this.config.getUsable(existing.configId ?? null);
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const tenantId = this.currentTenantId();
    if (existing.netpayTransactionId !== null && existing.status !== 'FAILED') {
      // A previous attempt was submitted and Netpay has not reported it unsuccessful:
      // ask Netpay before a second charge can bill the buyer twice (BN-REQ-PAY-002).
      await this.settlePreviousAttempt(schemaName, existing, existing.netpayTransactionId, config, tenantId);
    }
    // The fingerprint and the session id are one value: the one the browser
    // produced while tokenising. Netpay's 3DS 2.0 fails without it, so there is
    // no generated fallback.
    const sessionId = input.deviceFingerPrint;
    // Claimed before the provider is called: without it, two concurrent requests
    // both pass the checks above and the buyer is charged twice.
    //
    // The bound transaction is part of the condition: it must still be the one
    // checked above (none, the declined one, or the one Netpay just reported as not
    // charged). A request that read the order before a concurrent charge bound a new
    // transaction loses here, which is what a claim alone cannot do, because that
    // charge released its claim as soon as it wrote the transaction. Once the
    // previous attempt is settled the guard no longer blocks a new attempt, which is
    // what the old `netpayTransactionId: null` condition did (BN-REQ-PAY-001).
    await this.claimOrder(existing.id, 'charge', {
      status: { in: [...CHARGEABLE_STATUSES] },
      netpayTransactionId: existing.netpayTransactionId,
    });
    /** An order bound before attempts were recorded counts that transaction as attempt 1. */
    const legacyBound = existing.netpayTransactionId !== null;
    /** Set once the charge request is on its way: from then on its outcome may be unknown. */
    let chargeSent = false;
    /** Set when the claim must outlive this request: a result waits to be applied. */
    let keepClaim = false;
    try {
      // Netpay only charges a token that belongs to a customer, and answers
      // "Invalid Token" to one that does not, so the card is attached to a
      // customer first. A caller that already holds a customer passes it instead.
      let clientId = input.clientId;
      // True when this call attached the card to a customer only to be able to
      // charge it, which must not leave the card stored.
      const createdProfile = clientId === undefined;
      if (clientId === undefined) {
        const profile = await this.netpay.createClient(config.environment, config.secretKey, {
          firstName: netpayText(input.billing.firstName),
          lastName: netpayText(input.billing.lastName),
          phone: input.billing.phone,
          email: input.billing.email,
          identifier: netpayText(input.buyerIdentifier ?? existing.orderReference),
          paymentSource: { type: 'card', source: input.cardToken },
        });
        clientId = profile.id;
      }
      const body: NetpayChargeBody = {
        transactionType: 'Auth',
        amount: Number(amount),
        currency: existing.currency,
        description: netpayText(`Order ${existing.merchantReferenceCode}`),
        paymentMethod: 'card',
        source: input.cardToken,
        sessionId,
        deviceFingerPrint: sessionId,
        referenceID: input.referenceId ?? existing.orderReference,
        saveCard: input.saveCard === true ? 'true' : 'false',
        ...(input.cvv === undefined ? {} : { cvv: input.cvv }),
        billing: {
          firstName: netpayText(input.billing.firstName),
          lastName: netpayText(input.billing.lastName),
          email: input.billing.email,
          phone: input.billing.phone,
          // Unique per order, as the documentation asks of this reference.
          merchantReferenceCode: existing.orderReference,
          address: {
            ...input.billing.address,
            city: netpayText(input.billing.address.city),
            street1: netpayText(input.billing.address.street1),
            ...(input.billing.address.street2 === undefined
              ? {}
              : { street2: netpayText(input.billing.address.street2) }),
          },
        },
        client: { id: clientId },
        // Only the documented fields travel, so a caller cannot pad the request.
        deviceInformation: Object.fromEntries(
          REQUIRED_DEVICE_FIELDS.map((key) => [key, input.deviceInformation[key]]),
        ),
        ...(input.installments === undefined
          ? {}
          : { installments: { plan: { count: input.installments, interval: 'month' as const } } }),
      };
      chargeSent = true;
      const transaction = await this.netpay.createCharge(
        config.environment,
        config.secretKey,
        body,
        input.userAgent,
      );
      if (createdProfile && input.saveCard !== true) {
        await this.discardTransientCard(config, clientId, input.cardToken);
      }
      const transactionId =
        typeof transaction.transactionTokenId === 'string' ? transaction.transactionTokenId : null;
      if (transactionId === null) {
        // Netpay answered without naming a transaction: nothing tells whether the
        // card was charged, so the order is left exactly as after a timeout.
        keepClaim = true;
        await this.markChargeUnknown(schemaName, existing, tenantId, legacyBound);
        return {
          transactionTokenId: null,
          status: transaction.status ?? null,
          amount: transaction.amount ?? null,
          currency: transaction.currency ?? existing.currency,
          orderStatus: STATUS_CHARGE_UNKNOWN,
        };
      }
      const outcome = parseStatus(transaction.status);
      const declined = outcome !== null && FAILED_STATUSES.includes(outcome);
      const savedCustomerId = input.saveCard === true ? clientId : null;
      // The attempt, the bound transaction and the saved customer are written in one
      // transaction. If that write fails, Netpay's answer is kept as a pending result
      // and the claim holds until reconciliation applies it (BN-REQ-IDM-004).
      const recorded: PendingPayload = {
        kind: 'charge',
        outcome: declined ? 'declined' : 'submitted',
        transactionId,
        priorStatus: existing.status,
        legacyBound,
        ...(declined
          ? {
              failureReason: transaction.declineReason ?? 'The provider declined the charge.',
              failureCode: transaction.failureCode ?? 'UNKNOWN',
              providerFailureCode: transaction.providerFailureCode ?? null,
            }
          : {}),
        savedCustomerId: createdProfile ? savedCustomerId : null,
        savedCardToken: createdProfile && savedCustomerId !== null ? input.cardToken : null,
      };
      let orderStatus: string;
      try {
        const updated = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
          this.applyChargeResultIn(client, existing.id, recorded, tenantId, new Date()),
        );
        await this.reportChange(existing.id, updated, tenantId);
        orderStatus = updated.row.status;
      } catch (writeError) {
        keepClaim = true;
        await this.holdPendingResult(schemaName, existing.id, recorded, writeError);
        throw new ProviderResultPendingException('charge');
      }
      if (!declined) {
        // The provider decides the outcome, and it already knows it: asking now
        // settles the order without waiting for a notification, which matters where
        // Netpay cannot reach this server. A failure here changes nothing; the
        // notification, or a later retry, still concludes the order.
        try {
          const result = await this.verifyOrderInSchema(schemaName, existing.id, transactionId, tenantId);
          orderStatus = result.status;
        } catch {
          this.logger.warn(`Could not verify order ${existing.id} right after the charge.`);
        }
      }
      // Netpay echoes the whole request back, including the CVV and the card
      // details, so only what a storefront needs is returned.
      return {
        transactionTokenId: transactionId,
        status: transaction.status ?? null,
        amount: transaction.amount ?? null,
        currency: transaction.currency ?? existing.currency,
        orderStatus,
        ...(transaction.threeDSecureResponse === undefined
          ? {}
          : { threeDSecureResponse: transaction.threeDSecureResponse }),
        ...(typeof transaction.declineReason === 'string'
          ? { declineReason: transaction.declineReason }
          : {}),
        ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
      };
    } catch (error) {
      // An unknown outcome of the charge itself keeps the claim (BN-REQ-PAY-011) and
      // turns the order CHARGE_UNKNOWN (BN-REQ-PAY-003): the buyer may have been
      // charged, so the order is left for verification rather than reopened. A
      // failure before the charge was sent charged nobody.
      if (chargeSent && isProviderOutcomeUnknown(error)) {
        await this.markChargeUnknown(schemaName, existing, tenantId, legacyBound);
      } else if (!keepClaim) {
        await this.releaseClaim(existing.id);
      }
      throw error;
    }
  }

  /**
   * Decides, with Netpay, whether a previous attempt still bound to the order allows
   * a new charge (BN-REQ-PAY-002).
   *
   *  * Netpay reports it declined or failed: the order becomes FAILED and the new
   *    charge proceeds.
   *  * It is still waiting for 3-D Secure (`WAIT_THREEDS`): it was never confirmed,
   *    so nothing was charged. The attempt is marked ABANDONED and the new charge
   *    proceeds; the claim condition makes sure no other charge slipped in.
   *  * Netpay reports it charged: the order is settled from that answer and the new
   *    charge is refused with 409 `ORDER_STATE_CONFLICT`, carrying the PAID order.
   *  * Anything else (`REVIEW`, `IN_PROCESS`…) is undecided: refused, 409.
   *
   * @param schemaName Tenant schema.
   * @param existing The order.
   * @param transactionId The previous attempt's transaction.
   * @param config Tenant provider configuration.
   * @param tenantId Tenant.
   * @throws {OrderStateConflictException} When the new charge must not proceed.
   */
  private async settlePreviousAttempt(
    schemaName: string,
    existing: OrderRow,
    transactionId: string,
    config: { environment: NetpayEnvironment; secretKey: string },
    tenantId: string,
  ): Promise<void> {
    const transaction = await this.netpay.getTransaction(config.environment, config.secretKey, transactionId);
    const status = parseStatus(transaction.status);
    if (status === 'WAIT_THREEDS') {
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentAttempt.updateMany({
          where: { orderId: existing.id, netpayTransactionId: transactionId },
          data: { status: ATTEMPT.ABANDONED },
        }),
      );
      return;
    }
    if (status === null || !(PROVIDER_SETTLED.has(status) || FAILED_STATUSES.includes(status))) {
      throw new OrderStateConflictException(
        'A charge for this order is still awaiting a decision from Netpay.',
        { status: existing.status },
      );
    }
    const result = await this.applyVerification(schemaName, existing, transactionId, transaction, tenantId);
    if (result.status === 'FAILED') {
      return;
    }
    const order = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.findFirstOrThrow({ where: { id: existing.id }, select: this.orderSelect() }),
    );
    throw new OrderStateConflictException(
      order.status === STATUS_PAID
        ? 'The previous attempt of this order was charged; the order is now PAID.'
        : `The previous attempt of this order left it ${order.status}.`,
      { status: order.status, order: this.toView(order) },
    );
  }

  /**
   * Records a charge sent without a definitive answer: the order turns
   * CHARGE_UNKNOWN with an UNKNOWN attempt, and keeps its claim (BN-REQ-PAY-003).
   *
   * If even that write fails, the doubt is kept as a pending result, which also
   * blocks every new claim on the order until it is applied.
   *
   * @param schemaName Tenant schema.
   * @param existing The order as read before the charge.
   * @param tenantId Tenant.
   * @param legacyBound Whether the order had a transaction before attempts existed.
   */
  private async markChargeUnknown(
    schemaName: string,
    existing: OrderRow,
    tenantId: string,
    legacyBound: boolean,
  ): Promise<void> {
    const recorded: PendingPayload = {
      kind: 'charge',
      outcome: 'unknown',
      transactionId: null,
      priorStatus: existing.status,
      legacyBound,
    };
    try {
      const updated = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        this.applyChargeResultIn(client, existing.id, recorded, tenantId, new Date()),
      );
      await this.reportChange(existing.id, updated, tenantId);
    } catch (writeError) {
      await this.holdPendingResult(schemaName, existing.id, recorded, writeError).catch(() => undefined);
    }
  }

  /**
   * Writes what a charge produced, inside the caller's transaction: the attempt,
   * the bound transaction, the saved customer and the order status.
   *
   * Shared by the charge itself and by {@link applyPendingProviderResults}, so a
   * result applied later is applied exactly as it would have been at once.
   *
   * @param client Tenant transaction.
   * @param orderId Order.
   * @param result What Netpay answered.
   * @param tenantId Tenant.
   * @param now Time of the change.
   * @returns The change.
   */
  private async applyChargeResultIn(
    client: TenantClient,
    orderId: string,
    result: Extract<PendingPayload, { kind: 'charge' }>,
    tenantId: string,
    now: Date,
  ): Promise<StatusChange> {
    const saveCustomer = async (tx: TenantClient): Promise<void> => {
      if (result.savedCustomerId === null || result.savedCustomerId === undefined) {
        return;
      }
      // The saved card's customer becomes this tenant's, so it can be charged
      // again with `clientId` (BN-REQ-PAY-012).
      await tx.paymentCustomer.upsert({
        where: { netpayCustomerId: result.savedCustomerId },
        update: { updatedAt: now },
        create: {
          tenantId,
          netpayCustomerId: result.savedCustomerId,
          defaultTokenId: result.savedCardToken ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
    };
    if (result.outcome === 'unknown') {
      return this.applyStatusIn(
        client,
        orderId,
        STATUS_CHARGE_UNKNOWN,
        now,
        {},
        {
          tenantId,
          attempt: {
            kind: 'new',
            transactionId: null,
            status: ATTEMPT.UNKNOWN,
            legacyBound: result.legacyBound,
          },
        },
      );
    }
    if (result.outcome === 'declined') {
      // A decline comes from Netpay's own authenticated answer to this request, not
      // from an unsigned notification, so it is recorded at once. Waiting for a
      // verification that may fail would leave the order looking "in progress" and
      // refuse the buyer's retry with another card. Announced even when a previous
      // attempt had already failed: it is a new decline of a new transaction.
      return this.applyStatusIn(
        client,
        orderId,
        'FAILED',
        now,
        {
          netpayTransactionId: result.transactionId,
          ...(result.savedCustomerId ? { netpayCustomerId: result.savedCustomerId } : {}),
          lastVerifiedAt: now,
          failureReason: result.failureReason ?? 'The provider declined the charge.',
          failureCode: result.failureCode ?? 'UNKNOWN',
          providerFailureCode: result.providerFailureCode ?? null,
          operationClaim: null,
          operationClaimedAt: null,
        },
        {
          tenantId,
          event: PAYMENT_EVENTS.FAILED,
          attempt: {
            kind: 'new',
            transactionId: result.transactionId,
            status: ATTEMPT.FAILED,
            declineCode: result.failureCode ?? 'UNKNOWN',
            legacyBound: result.legacyBound,
          },
          also: saveCustomer,
        },
      );
    }
    // Submitted and not declined. The claim goes with the write: the bound
    // transaction is what refuses a second charge from here on (see the claim
    // condition), and a FAILED order leaves FAILED, so its next charge verifies this
    // attempt first.
    return this.applyStatusIn(
      client,
      orderId,
      result.priorStatus === 'FAILED' ? 'PENDING_VERIFICATION' : (result.priorStatus as PaymentStatus),
      now,
      {
        netpayTransactionId: result.transactionId,
        ...(result.savedCustomerId ? { netpayCustomerId: result.savedCustomerId } : {}),
        failureReason: null,
        failureCode: null,
        providerFailureCode: null,
        operationClaim: null,
        operationClaimedAt: null,
      },
      {
        tenantId,
        attempt: {
          kind: 'new',
          transactionId: result.transactionId,
          status: ATTEMPT.SUBMITTED,
          legacyBound: result.legacyBound,
        },
        also: saveCustomer,
      },
    );
  }

  /**
   * Keeps a result Netpay confirmed whose local write failed (BN-REQ-IDM-004).
   *
   * A separate, minimal insert: the order's claim is not released, and while the
   * row is unapplied no operation can claim the order. Reconciliation applies it
   * with {@link applyPendingProviderResults}.
   *
   * @param schemaName Tenant schema.
   * @param orderId Order.
   * @param payload What to apply.
   * @param writeError The failure of the original write, rethrown when even this insert fails.
   */
  private async holdPendingResult(
    schemaName: string,
    orderId: string,
    payload: PendingPayload,
    writeError: unknown,
  ): Promise<void> {
    try {
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.pendingProviderResult.create({
          data: {
            id: randomUUID(),
            orderId,
            operation: payload.kind,
            providerPayload: payload,
            createdAt: new Date(),
          },
        }),
      );
      this.logger.error(
        `Netpay confirmed a ${payload.kind} on order ${orderId} but the local write failed; kept as a pending provider result.`,
      );
    } catch {
      // Nothing more can be written. The claim still holds for its window; the
      // operator alert is this line plus the 500 the caller receives.
      this.logger.error(
        `Netpay confirmed a ${payload.kind} on order ${orderId}; neither the result nor the pending record could be written.`,
      );
      throw writeError;
    }
  }

  /**
   * Applies the provider results that wait in `pending_provider_result`, each once
   * (BN-REQ-IDM-004). Called by reconciliation.
   *
   * One row per transaction: the row is locked with `FOR UPDATE SKIP LOCKED`, the
   * order is changed and the row is stamped `appliedAt` in the same transaction, so
   * two concurrent runs never apply a row twice and a crash applies nothing. A row
   * whose effect is already on the order (the original write did commit after all)
   * is stamped `already_applied` without touching the order again.
   *
   * @param tenant Tenant whose schema to work on.
   * @returns How many rows were applied, found already applied, and failed.
   */
  async applyPendingProviderResults(tenant: {
    readonly id: string;
    readonly schemaName: string;
  }): Promise<{ applied: number; alreadyApplied: number; failed: number }> {
    const counts = { applied: 0, alreadyApplied: 0, failed: 0 };
    const table = Prisma.raw(`${quoteIdentifier(tenant.schemaName)}."pending_provider_result"`);
    for (let i = 0; i < PENDING_RESULTS_PER_RUN; i += 1) {
      let outcome: {
        kind: string;
        change: StatusChange | null;
        orderId: string;
        verify: string | null;
      } | null;
      try {
        outcome = await this.tenantPrisma.forTenantTransaction(tenant.schemaName, async (client) => {
          const [locked] = await client.$queryRaw<{ id: string }[]>(
            Prisma.sql`SELECT "id" FROM ${table}
              WHERE "appliedAt" IS NULL
              ORDER BY "createdAt" ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED`,
          );
          if (locked === undefined) {
            return null;
          }
          const pending = await client.pendingProviderResult.findUniqueOrThrow({ where: { id: locked.id } });
          const now = new Date();
          const applied = await this.applyPendingIn(
            client,
            pending.orderId,
            pending.providerPayload as unknown as PendingPayload,
            tenant.id,
            now,
          );
          await client.pendingProviderResult.update({
            where: { id: pending.id },
            data: { appliedAt: now, outcome: applied.kind },
          });
          return { ...applied, orderId: pending.orderId };
        });
      } catch {
        // Left unapplied for the next run; the claim keeps the order safe meanwhile.
        this.logger.error(`A pending provider result in ${tenant.schemaName} could not be applied.`);
        counts.failed += 1;
        break;
      }
      if (outcome === null) {
        break;
      }
      if (outcome.kind === 'already_applied') {
        counts.alreadyApplied += 1;
      } else {
        counts.applied += 1;
      }
      if (outcome.change !== null) {
        // Only reconciliation applies pending results.
        await this.reportChange(outcome.orderId, outcome.change, tenant.id, 'reconciliation');
      }
      if (outcome.verify !== null) {
        // A submitted charge is concluded by Netpay's answer, as right after a charge.
        await this.verifyOrderInSchema(tenant.schemaName, outcome.orderId, outcome.verify, tenant.id).catch(
          () =>
            this.logger.warn(`Could not verify order ${outcome?.orderId ?? ''} after applying its result.`),
        );
      }
    }
    return counts;
  }

  /**
   * Applies one pending result inside the applier's transaction.
   *
   * @param client Tenant transaction.
   * @param orderId Order.
   * @param payload What Netpay confirmed.
   * @param tenantId Tenant.
   * @param now Time of the change.
   * @returns How it was applied, the change, and a transaction to verify afterwards.
   */
  private async applyPendingIn(
    client: TenantClient,
    orderId: string,
    payload: PendingPayload,
    tenantId: string,
    now: Date,
  ): Promise<{ kind: 'applied' | 'already_applied'; change: StatusChange | null; verify: string | null }> {
    const order = await client.paymentOrder.findFirstOrThrow({
      where: { id: orderId },
      select: { amount: true, refundedAmount: true, status: true, netpayTransactionId: true },
    });
    const releaseClaim = async (): Promise<void> => {
      await client.paymentOrder.update({
        where: { id: orderId },
        data: { operationClaim: null, operationClaimedAt: null },
      });
    };
    if (payload.kind === 'refund') {
      if (order.refundedAmount.toFixed(2) !== payload.refundedAmountBefore) {
        await releaseClaim();
        return { kind: 'already_applied', change: null, verify: null };
      }
      const refunded = new Prisma.Decimal(payload.amount);
      const total = order.refundedAmount.plus(refunded);
      const change = await this.applyStatusIn(
        client,
        orderId,
        total.greaterThanOrEqualTo(order.amount) ? STATUS_REFUNDED : STATUS_PARTIALLY_REFUNDED,
        now,
        { refundedAmount: total, failureReason: null, operationClaim: null, operationClaimedAt: null },
        { tenantId, event: PAYMENT_EVENTS.REFUNDED, refunded },
      );
      return { kind: 'applied', change, verify: null };
    }
    const alreadyThere =
      payload.outcome === 'unknown'
        ? order.status === STATUS_CHARGE_UNKNOWN
        : order.netpayTransactionId === payload.transactionId;
    if (alreadyThere) {
      if (payload.outcome !== 'unknown') {
        await releaseClaim();
      }
      return { kind: 'already_applied', change: null, verify: null };
    }
    const change = await this.applyChargeResultIn(client, orderId, payload, tenantId, now);
    return {
      kind: 'applied',
      change,
      verify: payload.outcome === 'submitted' ? payload.transactionId : null,
    };
  }

  /**
   * Refunds a settled order.
   *
   * A reversal is a new event rather than an edit of the original record, and it
   * is only possible from `PAID`: without that there is nothing settled to
   * reverse. Refunding twice is refused rather than attempted, because the
   * provider would reject it and the audit trail would claim two reversals.
   *
   * @param orderId Order to refund.
   * @returns The resulting status.
   * @throws {ConflictException} When the order is not in a refundable state.
   */
  async refund(
    orderId: string,
    motive = 'Refund',
    amount?: string,
  ): Promise<{ status: string; refundedAmount: string; refunded: string }> {
    const existing = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findFirst({ where: { id: orderId }, select: this.orderSelect() }),
    );
    if (existing === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    // PAID, or PARTIALLY_REFUNDED with something left (BN-REQ-PAY-005).
    if (!REFUNDABLE_STATUSES.includes(existing.status)) {
      throw new ConflictException(`Only a settled order can be refunded; this one is ${existing.status}.`);
    }
    if (existing.netpayTransactionId === null) {
      throw new ConflictException('This order has no transaction to reverse.');
    }
    const remaining = existing.amount.minus(existing.refundedAmount);
    const requested = amount === undefined ? remaining : this.parseRefundAmount(amount);
    if (requested === null || requested.lessThanOrEqualTo(0)) {
      throw new ValidationException('The refund amount must be a positive value with at most two decimals.');
    }
    if (requested.greaterThan(remaining)) {
      throw new ConflictException(
        `The refund exceeds what was charged: ${remaining.toFixed(2)} of ${existing.amount.toFixed(2)} is left to refund.`,
      );
    }
    // The keys the order was charged with (BN-REQ-CFG-002).
    const config = await this.config.getUsable(existing.configId ?? null);
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const tenantId = this.currentTenantId();
    // Claimed before the provider is called: two concurrent refunds would both
    // see a settled order and both reverse the transaction. The claim also requires
    // the refunded total read above, so `remaining` cannot be stale: a refund that
    // completed in between (and released its claim) makes this claim lose.
    await this.claimOrder(existing.id, 'refund', {
      status: { in: [...REFUNDABLE_STATUSES] },
      refundedAmount: existing.refundedAmount,
    });
    try {
      await this.reverseAtProvider(
        config,
        existing.netpayTransactionId,
        requested,
        motive,
        existing.refundedAmount.isZero() && requested.equals(existing.amount),
      );
    } catch (error) {
      // An unknown outcome keeps the claim (BN-REQ-PAY-011): the reversal may have
      // been carried out, and a retry must not reverse twice.
      if (!isProviderOutcomeUnknown(error)) {
        await this.releaseClaim(existing.id);
      }
      throw error;
    }
    // The reversal happened, so the claim is cleared together with the new total.
    const total = existing.refundedAmount.plus(requested);
    const full = total.greaterThanOrEqualTo(existing.amount);
    let updated: StatusChange;
    try {
      updated = await this.applyStatus(
        schemaName,
        existing.id,
        full ? STATUS_REFUNDED : STATUS_PARTIALLY_REFUNDED,
        new Date(),
        {
          // Added in the database rather than overwritten with a total computed here.
          refundedAmount: { increment: requested },
          failureReason: null,
          operationClaim: null,
          operationClaimedAt: null,
        },
        // Every refund is announced, a second partial one included, which leaves the
        // status where it was: the event is forced rather than derived from a change.
        { tenantId, event: PAYMENT_EVENTS.REFUNDED, refunded: requested },
      );
    } catch (writeError) {
      // Netpay reversed the money and the order does not say so. The claim stays
      // and the result waits to be applied by reconciliation (BN-REQ-IDM-004): a
      // retry must never reverse again.
      await this.holdPendingResult(
        schemaName,
        existing.id,
        {
          kind: 'refund',
          transactionId: existing.netpayTransactionId,
          amount: requested.toFixed(2),
          refundedAmountBefore: existing.refundedAmount.toFixed(2),
        },
        writeError,
      );
      throw new ProviderResultPendingException('refund');
    }
    return {
      status: updated.row.status,
      refundedAmount: total.toFixed(2),
      refunded: requested.toFixed(2),
    };
  }

  /**
   * Reverses a charge at Netpay.
   *
   * A whole charge is cancelled through the gateway first: it is the call that works
   * in the sandbox and in Live before the 21:30 cut-off. If Netpay refuses it (cut-off
   * passed, or the account lacks the operation) the refund service is tried, which is
   * also the only route for a partial amount. A transport failure is NOT retried on the
   * other route: the first call may have been carried out, and reversing twice is worse
   * than reporting the doubt.
   *
   * @param config Tenant provider configuration with the secret key.
   * @param transactionId Transaction to reverse.
   * @param amount Amount to return.
   * @param motive Reason recorded with the reversal.
   * @param whole Whether the amount is the full charge, still untouched.
   */
  private async reverseAtProvider(
    config: { environment: NetpayEnvironment; secretKey: string },
    transactionId: string,
    amount: Prisma.Decimal,
    motive: string,
    whole: boolean,
  ): Promise<void> {
    if (whole) {
      try {
        const status = await this.netpay.cancelCharge(config.environment, config.secretKey, transactionId);
        if (status !== null && status.toUpperCase() === 'CANCELED') {
          return;
        }
        this.logger.warn(
          `Cancelling ${transactionId} answered ${String(status)}; trying the refund service.`,
        );
      } catch (error) {
        if (!(error instanceof NetpayRequestError)) {
          throw error;
        }
        // A definitive refusal (4xx: Netpay says the operation is not permitted,
        // the cut-off passed) is a safe fallback: the cancellation did not happen.
        // A 5xx is not a refusal, it is an unknown outcome: the cancellation may
        // have been carried out and reversing again on the other route would bill
        // the customer twice. Same criterion as a transport failure, and it is
        // what leaves the order refundable for a retry.
        if (error.providerStatus >= 500) {
          throw error;
        }
        this.logger.warn(`Netpay refused to cancel ${transactionId}; trying the refund service.`);
      }
    }
    await this.netpay.refund(config.environment, config.secretKey, transactionId, amount.toFixed(2), motive);
  }

  /**
   * Parses a caller-supplied refund amount.
   *
   * @param raw Amount as sent.
   * @returns The exact decimal, or `null` when it is not a two-decimal amount.
   */
  private parseRefundAmount(raw: string): Prisma.Decimal | null {
    return /^\d{1,10}(\.\d{1,2})?$/.test(raw.trim()) ? new Prisma.Decimal(raw.trim()) : null;
  }

  /**
   * Attaches the cash reference Netpay reported for a hosted order.
   *
   * On the hosted page the buyer may choose cash; Netpay then announces the
   * reference (`cep.created`). Recording it lets the later `oxxopay.paid` be matched
   * and lets the storefront show the reference. Idempotent, and it never replaces a
   * reference that is already set.
   *
   * @param schemaName Tenant schema.
   * @param orderId Order to update.
   * @param reference Cash reference reported by Netpay.
   * @param expiresAt When it stops being payable, if known.
   */
  async attachCashReferenceInSchema(
    schemaName: string,
    orderId: string,
    reference: string,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.updateMany({
        where: {
          id: orderId,
          paymentReference: null,
          status: { notIn: [...SETTLED_ORDER_STATUSES] },
        },
        data: {
          paymentMethod: 'OXXO',
          paymentReference: reference.slice(0, 64),
          ...(expiresAt === null ? {} : { paymentReferenceExpiresAt: expiresAt }),
          updatedAt: new Date(),
        },
      }),
    );
  }

  /**
   * Confirms a charge after the buyer passed 3-D Secure.
   *
   * The provider is asked first and the call is made only while the transaction
   * is `WAIT_THREEDS`: confirming anything else is meaningless, and Netpay warns
   * that repeating a confirmation repeats the request to the bank. The order is
   * claimed for the call so concurrent requests cannot repeat it either.
   *
   * @param orderId Order id.
   * @param processorTransactionId Id the 3DS library handed back to the browser;
   *   `null` when the library said no challenge was needed.
   * @returns The order status after the provider was asked again.
   * @throws {NotFoundException} When the order does not exist or has no charge.
   * @throws {ConflictException} When the transaction is not waiting for confirmation.
   */
  async confirmCharge(orderId: string, processorTransactionId: string | null): Promise<{ status: string }> {
    const existing = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findFirst({ where: { id: orderId }, select: this.orderSelect() }),
    );
    if (existing === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    if (existing.netpayTransactionId === null) {
      throw new ConflictException('This order has no charge to confirm.');
    }
    if (SETTLED_ORDER_STATUSES.includes(existing.status)) {
      throw new ConflictException('This order is already settled.');
    }
    if (TERMINAL_UNPAID_STATUSES.includes(existing.status)) {
      // Confirming would send the charge to the bank for an order the merchant withdrew.
      throw new OrderStateConflictException(`An order in ${existing.status} cannot be confirmed.`, {
        status: existing.status,
      });
    }
    const config = await this.config.getUsable(existing.configId ?? null);
    const transaction = await this.netpay.getTransaction(
      config.environment,
      config.secretKey,
      existing.netpayTransactionId,
    );
    if (parseStatus(transaction.status) !== 'WAIT_THREEDS') {
      throw new ConflictException('The transaction is not waiting for 3-D Secure confirmation.');
    }
    await this.claimOrder(existing.id, 'confirm', { status: { notIn: [...SETTLED_ORDER_STATUSES] } });
    await this.netpay.confirmCharge(
      config.environment,
      config.secretKey,
      existing.netpayTransactionId,
      processorTransactionId,
    );
    // The claim is released by the settlement below, not here. Releasing it as
    // soon as the provider answered would leave, until the order is settled, a
    // state where it is confirmable and free: a second confirmation would claim
    // it and repeat the request to the bank, which is the one thing Netpay warns
    // about. If the settlement fails, the claim expires on its own and the
    // notification still concludes the order.
    const result = await this.verifyOrderInSchema(
      this.tenantPrisma.requireCurrentSchema(),
      existing.id,
      existing.netpayTransactionId,
      this.currentTenantId(),
    );
    return { status: result.status };
  }

  /**
   * Cancels an unpaid order (BN-REQ-PAY-004).
   *
   * Allowed from PENDING, PENDING_VERIFICATION and FAILED. When a charge is bound
   * and not declined, Netpay is asked first: a charge that went through settles the
   * order and the cancellation is refused with 409 and the PAID order; a 3-D Secure
   * challenge never completed is abandoned; anything still undecided is refused. A
   * CHARGE_UNKNOWN order is refused until a verification (or reconciliation)
   * resolves it. An order already CANCELLED is answered as it is.
   *
   * Netpay offers no call to expire a hosted session or a cash reference, so the
   * order is only marked: a payment Netpay reports later keeps it CANCELLED, sets
   * `paidAfterCancelAt` and emits `payment.paid_after_cancel` (audited as
   * `LATE_PAYMENT_ON_CANCELLED`), for the consumer to refund.
   *
   * @param orderId Order to cancel.
   * @returns The cancelled order.
   * @throws {OrderStateConflictException} 409 when the order cannot be cancelled.
   */
  async cancel(orderId: string): Promise<PaymentOrderView> {
    const existing = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findFirst({ where: { id: orderId }, select: this.orderSelect() }),
    );
    if (existing === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    if (existing.status === STATUS_CANCELLED) {
      return this.toView(existing);
    }
    if (!CANCELLABLE_STATUSES.includes(existing.status)) {
      throw new OrderStateConflictException(
        existing.status === STATUS_CHARGE_UNKNOWN
          ? 'A charge of this order got no definitive answer from Netpay; verify the order before cancelling it.'
          : `An order in ${existing.status} cannot be cancelled.`,
        { status: existing.status },
      );
    }
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const tenantId = this.currentTenantId();
    if (existing.netpayTransactionId !== null && existing.status !== 'FAILED') {
      await this.assertNothingCharged(schemaName, existing, existing.netpayTransactionId, tenantId);
    }
    await this.claimOrder(existing.id, 'cancel', { status: { in: [...CANCELLABLE_STATUSES] } });
    try {
      const updated = await this.applyStatus(
        schemaName,
        existing.id,
        STATUS_CANCELLED,
        new Date(),
        { operationClaim: null, operationClaimedAt: null },
        { tenantId, expectFrom: CANCELLABLE_STATUSES },
      );
      if (updated.row.status !== STATUS_CANCELLED) {
        throw new OrderStateConflictException(`The order moved to ${updated.row.status} meanwhile.`, {
          status: updated.row.status,
        });
      }
      return this.toView(updated.row);
    } catch (error) {
      await this.releaseClaim(existing.id);
      throw error;
    }
  }

  /**
   * Before a cancellation, asks Netpay about the charge bound to the order.
   *
   * @param schemaName Tenant schema.
   * @param existing The order.
   * @param transactionId Its bound transaction.
   * @param tenantId Tenant.
   * @throws {OrderStateConflictException} When it was charged, or is still undecided.
   */
  private async assertNothingCharged(
    schemaName: string,
    existing: OrderRow,
    transactionId: string,
    tenantId: string,
  ): Promise<void> {
    const config = await this.config.getUsable(existing.configId ?? null);
    const transaction = await this.netpay.getTransaction(config.environment, config.secretKey, transactionId);
    const status = parseStatus(transaction.status);
    if (status !== null && PROVIDER_SETTLED.has(status)) {
      await this.applyVerification(schemaName, existing, transactionId, transaction, tenantId);
      const order = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentOrder.findFirstOrThrow({ where: { id: existing.id }, select: this.orderSelect() }),
      );
      throw new OrderStateConflictException(
        `Netpay charged this order; it is now ${order.status} and cannot be cancelled.`,
        { status: order.status, order: this.toView(order) },
      );
    }
    if (status === 'WAIT_THREEDS') {
      // Never confirmed, so never sent to the bank: abandoned, like a retried charge.
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentAttempt.updateMany({
          where: { orderId: existing.id, netpayTransactionId: transactionId },
          data: { status: ATTEMPT.ABANDONED },
        }),
      );
      return;
    }
    if (status !== null && FAILED_STATUSES.includes(status)) {
      return;
    }
    if (existing.paymentReference !== null) {
      // A cash reference waiting at the store: unpaid. A payment after this is a late one.
      return;
    }
    throw new OrderStateConflictException(
      'A charge for this order is still awaiting a decision from Netpay.',
      {
        status: existing.status,
      },
    );
  }

  /**
   * Reconciles one order with Netpay (BN-REQ-REC-001…003), for the worker in
   * `reconciliation/reconciliation.service.ts`, which owns the selection, the lease
   * and the rate limit.
   *
   *  * CANCELLED / EXPIRED with a transaction: a payment Netpay reports is recorded
   *    as late (`payment.paid_after_cancel`), the status stays.
   *  * PAID / PARTIALLY_REFUNDED holding a `refund` claim (the refund's outcome was
   *    unknown): Netpay reporting the charge CANCELED completes it as REFUNDED; a
   *    charge still DONE is left for an operator (a partial refund leaves no trace
   *    Netpay reports).
   *  * CHARGE_UNKNOWN with no transaction named: after the grace period it goes
   *    back to PENDING, the attempt is UNRESOLVED and the claim released. Netpay
   *    cannot be searched by order reference, so this is a policy, not a proof: a
   *    charge that did happen still arrives by notification and settles the order
   *    (docs/RUNBOOK-PAYMENTS.md §1.1).
   *  * PENDING / PENDING_VERIFICATION with a transaction: a decided transaction is
   *    applied as a verification; one waiting for 3-D Secure longer than the
   *    timeout is EXPIRED (`payment.expired`); one undecided is left unwritten.
   *  * A cash reference past its expiry and unpaid: EXPIRED.
   *
   * Every write is guarded by the status read under the row lock, so a request or a
   * notification that moved the order meanwhile wins.
   *
   * @param tenant Tenant and its schema.
   * @param orderId Order leased by the caller.
   * @param ctx Clock, rate limit and thresholds.
   * @returns What happened.
   */
  async reconcileOrder(
    tenant: { readonly id: string; readonly schemaName: string },
    orderId: string,
    ctx: ReconcileOrderContext,
  ): Promise<ReconcileOrderOutcome> {
    const source = 'reconciliation';
    const schemaName = tenant.schemaName;
    const row = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.findFirst({
        where: { id: orderId },
        select: {
          ...this.orderSelect(),
          operationClaim: true,
          pendingProviderResults: { where: { appliedAt: null }, select: { id: true }, take: 1 },
        },
      }),
    );
    if (row === null) {
      return { from: 'UNKNOWN', to: 'UNKNOWN', corrected: false, action: 'skipped' };
    }
    const from = row.status;
    const unchanged = (action = 'unchanged'): ReconcileOrderOutcome => ({
      from,
      to: from,
      corrected: false,
      action,
    });
    if (row.pendingProviderResults.length > 0) {
      // A confirmed result waits to be applied; applyPendingProviderResults owns it.
      return unchanged('skipped');
    }
    let config: { environment: NetpayEnvironment; secretKey: string } | null = null;
    const ask = async (transactionId: string): Promise<NetpayTransaction> => {
      config ??= await this.config.getUsableInSchema(schemaName, row.configId ?? null);
      await ctx.beforeProviderCall();
      return this.netpay.getTransaction(config.environment, config.secretKey, transactionId);
    };
    const changed = (to: string, action: string, corrected = to !== from): ReconcileOrderOutcome => ({
      from,
      to,
      corrected,
      action,
    });

    if (TERMINAL_UNPAID_STATUSES.includes(from)) {
      if (row.netpayTransactionId === null || (row.paidAfterCancelAt ?? null) !== null) {
        return unchanged();
      }
      const transaction = await ask(row.netpayTransactionId);
      const status = parseStatus(transaction.status);
      if (status === null || !PROVIDER_SETTLED.has(status)) {
        return unchanged();
      }
      const result = await this.applyVerification(
        schemaName,
        row,
        row.netpayTransactionId,
        transaction,
        tenant.id,
        source,
      );
      return result.changed ? changed(result.status, 'paid_after_cancel', true) : unchanged();
    }

    if (REFUNDABLE_STATUSES.includes(from)) {
      if (row.operationClaim !== 'refund' || row.netpayTransactionId === null) {
        return unchanged();
      }
      const transaction = await ask(row.netpayTransactionId);
      const remaining = row.amount.minus(row.refundedAmount);
      if (parseStatus(transaction.status) !== 'CANCELED' || remaining.lessThanOrEqualTo(0)) {
        this.logger.warn({
          event: 'reconcile_manual_review',
          message: `order ${row.id}: a refund's outcome is unknown and Netpay still reports the charge; check Netpay Manager`,
          orderId: row.id,
          tenantId: tenant.id,
        });
        return unchanged('manual_review');
      }
      const updated = await this.applyStatus(
        schemaName,
        row.id,
        STATUS_REFUNDED,
        ctx.now,
        { refundedAmount: row.amount, failureReason: null, operationClaim: null, operationClaimedAt: null },
        {
          tenantId: tenant.id,
          event: PAYMENT_EVENTS.REFUNDED,
          refunded: remaining,
          expectFrom: REFUNDABLE_STATUSES,
          source,
        },
      );
      return changed(updated.row.status, 'refund_completed', updated.emittedEvent !== null);
    }

    const latest = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentAttempt.findFirst({
        where: { orderId: row.id },
        orderBy: { attemptNo: 'desc' },
        select: { netpayTransactionId: true, status: true, createdAt: true },
      }),
    );

    if (from === STATUS_CHARGE_UNKNOWN) {
      const since = (latest?.createdAt ?? row.updatedAt).getTime();
      if (ctx.now.getTime() - since < ctx.chargeUnknownGraceMs) {
        return unchanged();
      }
      const updated = await this.applyStatus(
        schemaName,
        row.id,
        'PENDING',
        ctx.now,
        {
          netpayTransactionId: null,
          failureReason: null,
          failureCode: null,
          providerFailureCode: null,
          operationClaim: null,
          operationClaimedAt: null,
        },
        {
          tenantId: tenant.id,
          expectFrom: [STATUS_CHARGE_UNKNOWN],
          source,
          also: async (client) => {
            await client.paymentAttempt.updateMany({
              where: { orderId: row.id, status: ATTEMPT.UNKNOWN, netpayTransactionId: null },
              data: { status: ATTEMPT.UNRESOLVED },
            });
          },
        },
      );
      return changed(updated.row.status, 'charge_unknown_reset');
    }

    if (!EXPIRABLE_STATUSES.includes(from)) {
      return unchanged();
    }
    const referenceExpired =
      row.paymentReference !== null &&
      row.paymentReferenceExpiresAt !== null &&
      row.paymentReferenceExpiresAt.getTime() < ctx.now.getTime() - ctx.referenceGraceMs;
    const expire = async (transactionId: string | null): Promise<ReconcileOrderOutcome> => {
      const updated = await this.applyStatus(
        schemaName,
        row.id,
        STATUS_EXPIRED,
        ctx.now,
        {
          failureReason:
            row.paymentReference === null
              ? 'The buyer did not complete 3-D Secure in time.'
              : 'The cash reference expired unpaid.',
          operationClaim: null,
          operationClaimedAt: null,
        },
        {
          tenantId: tenant.id,
          expectFrom: EXPIRABLE_STATUSES,
          source,
          ...(transactionId === null
            ? {}
            : { attempt: { kind: 'settle' as const, transactionId, status: ATTEMPT.ABANDONED } }),
        },
      );
      return changed(updated.row.status, 'expired');
    };

    const transactionId = row.netpayTransactionId;
    if (transactionId === null) {
      return referenceExpired ? expire(null) : unchanged();
    }
    const transaction = await ask(transactionId);
    const status = parseStatus(transaction.status);
    const reported = toAmountString(transaction.amount);
    const decided =
      (status !== null && (PROVIDER_SETTLED.has(status) || FAILED_STATUSES.includes(status))) ||
      (reported !== null && reported !== row.amount.toFixed(2));
    if (decided) {
      const result = await this.applyVerification(
        schemaName,
        row,
        transactionId,
        transaction,
        tenant.id,
        source,
      );
      return changed(result.status, 'verified');
    }
    if (status === 'WAIT_THREEDS' && row.paymentReference === null) {
      const since = (
        latest?.netpayTransactionId === transactionId ? latest.createdAt : row.updatedAt
      ).getTime();
      return ctx.now.getTime() - since >= ctx.threeDsTimeoutMs ? expire(transactionId) : unchanged();
    }
    if (referenceExpired) {
      return expire(transactionId);
    }
    if (from === 'PENDING') {
      // Netpay knows the transaction and has not decided: record that it was seen.
      const result = await this.applyVerification(
        schemaName,
        row,
        transactionId,
        transaction,
        tenant.id,
        source,
      );
      return changed(result.status, 'verified');
    }
    return unchanged();
  }

  /**
   * Checks a caller-supplied hosted return URL (BN-REQ-PAY-007).
   *
   * Always `https`. Within the tenant's `allowedReturnOrigins` once that list is
   * configured; while it is empty any `https` origin passes with a warning line
   * (`return_url_origin_unrestricted`), so existing integrations keep working until
   * the tenant sets its origins, and an operator can see who still relies on that.
   *
   * @param field `successUrl` or `cancelUrl`.
   * @param url URL as sent.
   * @param origins The tenant's allowlist.
   * @throws {ReturnUrlNotAllowedException} 422 `RETURN_URL_NOT_ALLOWED`.
   */
  private assertReturnUrl(field: string, url: string, origins: readonly string[]): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ReturnUrlNotAllowedException(field, null, `${field} is not a valid URL.`);
    }
    if (parsed.protocol !== 'https:') {
      throw new ReturnUrlNotAllowedException(field, parsed.origin, `${field} must use https.`);
    }
    if (origins.length === 0) {
      this.logger.warn({
        event: 'return_url_origin_unrestricted',
        message: `${field} accepted from ${parsed.origin}: this tenant has no allowedReturnOrigins yet`,
        field,
        origin: parsed.origin,
        tenantId: this.currentTenantId(),
      });
      return;
    }
    if (!origins.includes(parsed.origin)) {
      throw new ReturnUrlNotAllowedException(
        field,
        parsed.origin,
        `${field} must point to one of this tenant's allowedReturnOrigins.`,
      );
    }
  }

  /**
   * Removes a card that was attached to a customer only to make a charge possible.
   *
   * Netpay charges a token only when it belongs to a customer, so a one-time
   * payment creates a profile around the card. Without this the card would stay
   * stored although the buyer never asked for it. It runs right after the charge,
   * 3-D Secure included: the sandbox confirms a frictionless charge after the card
   * is gone, because confirmation is keyed by the transaction, not the card. A
   * failed clean-up never fails the payment.
   *
   * @param config Tenant provider configuration.
   * @param clientId Customer created for the charge.
   * @param cardToken Card to remove.
   */
  private async discardTransientCard(
    config: { environment: NetpayEnvironment; secretKey: string },
    clientId: string,
    cardToken: string,
  ): Promise<void> {
    try {
      await this.netpay.deleteCard(config.environment, config.secretKey, clientId, cardToken);
    } catch {
      this.logger.warn('Could not remove the one-time card from its customer profile.');
    }
  }

  /**
   * Requires the browser data 3-D Secure 2.0 needs.
   *
   * @param fingerprint Value produced by `NetPay.form.generateDeviceFingerPrint()`.
   * @param info Value produced by `NetPay.form.deviceInformation()`.
   * @throws {ValidationException} When either is missing or incomplete.
   */
  private assertDeviceData(fingerprint: unknown, info: unknown): void {
    if (typeof fingerprint !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(fingerprint)) {
      throw new ValidationException('deviceFingerPrint from Netpay tokenisation is required.');
    }
    const record = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : {};
    const missing = REQUIRED_DEVICE_FIELDS.filter((key) => {
      const value = record[key];
      return typeof value !== 'string' || value === '' || value.length > 64;
    });
    if (missing.length > 0) {
      throw new ValidationException(`deviceInformation is missing or invalid: ${missing.join(', ')}.`);
    }
  }

  /**
   * Reads a customer and the cards stored on it.
   *
   * @param clientId Netpay customer id.
   * @returns The id, identifier and cards, without any card number.
   */
  async getCustomer(clientId: string): Promise<{
    id: string;
    identifier: string | null;
    cards: { token: string; default: boolean; lastFourDigits: string | null; brand: string | null }[];
  }> {
    await this.assertOwnCustomer(clientId);
    const config = await this.config.getUsable();
    const info = await this.netpay.getClient(config.environment, config.secretKey, clientId);
    return {
      id: info.id ?? clientId,
      identifier: info.identifier ?? null,
      cards: (info.paymentSources ?? [])
        .filter((source): source is NonNullable<typeof source> => source !== null && source !== undefined)
        .map((source) => ({
          token: source.source ?? source.card?.token ?? '',
          default: source.cardDefault === true,
          lastFourDigits: source.card?.lastFourDigits ?? null,
          brand: source.card?.brand ?? null,
        })),
    };
  }

  /**
   * Attaches a card to a customer that already exists.
   *
   * Netpay allows one to three cards per customer, so the count is checked first
   * instead of letting the provider refuse the fourth.
   *
   * @param clientId Netpay customer id.
   * @param input Card token, its security code and whether to validate it with a hold.
   * @returns The stored card, without the number.
   */
  async assignCard(
    clientId: string,
    input: { cardToken: string; cvv: string; preAuth?: boolean },
  ): Promise<NetpayClientCard> {
    if (!NETPAY_CARD_TOKEN_PATTERN.test(input.cardToken)) {
      throw new ValidationException('cardToken must be a Netpay token, not card data.');
    }
    await this.assertOwnCustomer(clientId);
    const config = await this.config.getUsable();
    const current = await this.netpay.getClient(config.environment, config.secretKey, clientId);
    const held = (current.paymentSources ?? []).filter((source) => source !== null).length;
    if (held >= MAX_CARDS_PER_CLIENT) {
      throw new ConflictException(`A customer can hold at most ${MAX_CARDS_PER_CLIENT} cards.`);
    }
    const card = await this.netpay.assignCard(
      config.environment,
      config.secretKey,
      clientId,
      input.cardToken,
      input.cvv,
      input.preAuth === true,
    );
    // The provider echoes the card; only the non-sensitive part leaves this method.
    return {
      token: card.token,
      lastFourDigits: card.lastFourDigits,
      brand: card.brand,
      bank: card.bank,
      type: card.type,
      expMonth: card.expMonth,
      expYear: card.expYear,
    };
  }

  /**
   * Deletes a stored card from a customer.
   *
   * @param clientId Netpay customer id.
   * @param cardToken Card token to remove.
   */
  async deleteCard(clientId: string, cardToken: string): Promise<void> {
    await this.assertOwnCustomer(clientId);
    const config = await this.config.getUsable();
    await this.netpay.deleteCard(config.environment, config.secretKey, clientId, cardToken);
  }

  /**
   * Claims an order for one operation that calls the provider.
   *
   * A conditional update decides the winner in the database, so it holds across
   * instances. A claim older than {@link CLAIM_WINDOW_MS} is abandoned and can be
   * taken over, which keeps a crashed instance from locking an order forever.
   *
   * @param id Order id.
   * @param operation Operation taking the claim.
   * @param when Extra condition the order must still meet.
   * @throws {ConflictException} When another operation holds the order or it no longer qualifies.
   */
  private async claimOrder(
    id: string,
    operation: 'refund' | 'charge' | 'confirm' | 'cancel',
    when: Prisma.PaymentOrderWhereInput,
  ): Promise<void> {
    const now = new Date();
    const result = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.updateMany({
        where: {
          id,
          ...when,
          OR: [
            { operationClaimedAt: null },
            { operationClaimedAt: { lt: new Date(now.getTime() - CLAIM_WINDOW_MS) } },
          ],
          // A result Netpay confirmed and this system has not recorded yet holds the
          // order whatever the claim window says (BN-REQ-IDM-004).
          pendingProviderResults: { none: { appliedAt: null } },
        },
        data: { operationClaim: operation, operationClaimedAt: now },
      }),
    );
    if (result.count !== 1) {
      throw new ConflictException(
        'Another operation is in progress on this order, or it no longer qualifies.',
      );
    }
  }

  /**
   * Releases an order claim after a failed operation, so a retry is possible.
   *
   * @param id Order id.
   */
  private async releaseClaim(id: string): Promise<void> {
    try {
      await this.tenantPrisma.forCurrentTenantTransaction((client) =>
        client.paymentOrder.updateMany({
          where: { id },
          data: { operationClaim: null, operationClaimedAt: null },
        }),
      );
    } catch {
      // Left to expire: the claim window frees the order on its own.
      this.logger.error(`Could not release the claim on order ${id}; it will expire.`);
    }
  }

  /**
   * Binds a transaction id to an order that does not yet have one.
   *
   * @param schemaName Tenant schema.
   * @param orderReference Reference echoed by the provider.
   * @param transactionId Transaction to bind.
   * @returns The order id, or `null` when no order matches.
   */
  async bindTransactionInSchema(
    schemaName: string,
    orderReference: string,
    transactionId: string,
  ): Promise<string | null> {
    const row = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentOrder.findFirst({
        where: { orderReference },
        select: { id: true, netpayTransactionId: true },
      }),
    );
    if (row === null) {
      return null;
    }
    if (row.netpayTransactionId === null) {
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentOrder.update({
          where: { id: row.id },
          data: { netpayTransactionId: transactionId, updatedAt: new Date() },
        }),
      );
    }
    return row.id;
  }

  /**
   * Writes a status and, in the same transaction, the event it produces
   * (BN-REQ-EVT-004).
   *
   * The first statement is a write to the order row, which takes its row lock: a
   * concurrent change of the same order waits here and then reads the status the
   * other one committed, so a transition is announced once, with the right
   * `previousStatus`, and the outbox sequence follows the order of the changes.
   * The event is written with the same client, so it commits or rolls back with
   * the change. Logging and the audit record happen after the commit.
   *
   * @param schemaName Tenant schema.
   * @param id Order id.
   * @param status New status.
   * @param now Time of the change; becomes the event's `occurredAt`.
   * @param extra Additional columns.
   * @param change Tenant, and an event to emit even without a status change.
   * @returns The updated row, the status before it and the event written, if any.
   */
  private async applyStatus(
    schemaName: string,
    id: string,
    status: PaymentStatus,
    now: Date,
    extra: Record<string, unknown>,
    change: StatusChangeOptions,
  ): Promise<StatusChange> {
    let result: StatusChange;
    try {
      result = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        this.applyStatusIn(client, id, status, now, extra, change),
      );
    } catch (error) {
      if (!(error instanceof StaleTransitionError)) {
        throw error;
      }
      // The order moved on meanwhile; the change was rolled back and is a no-op.
      const row = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.paymentOrder.findFirstOrThrow({ where: { id }, select: this.orderSelect() }),
      );
      return { row, previousStatus: row.status, emittedEvent: null };
    }
    await this.reportChange(id, result, change.tenantId, change.source);
    return result;
  }

  /**
   * Reports a committed change (log line and audit), when the status moved.
   *
   * @param id Order id.
   * @param result The committed change.
   * @param tenantId Tenant.
   */
  private async reportChange(
    id: string,
    result: StatusChange,
    tenantId: string,
    source?: string,
  ): Promise<void> {
    if (result.previousStatus !== result.row.status) {
      await this.statusChanged(
        id,
        result.previousStatus,
        result.row.status,
        tenantId,
        result.emittedEvent,
        source,
      );
    }
    if (result.latePayment === true) {
      await this.latePaymentRecorded(result.row, tenantId, source);
    }
  }

  /**
   * Reports a payment Netpay confirmed for a CANCELLED or EXPIRED order: a warning
   * line and the `LATE_PAYMENT_ON_CANCELLED` audit record (BN-REQ-PAY-004).
   *
   * @param row The order after the change.
   * @param tenantId Tenant.
   * @param source What found it.
   */
  private async latePaymentRecorded(row: OrderRow, tenantId: string, source?: string): Promise<void> {
    const context = this.requestContext.get();
    const cause = source ?? (context.principal ? 'api' : 'webhook');
    this.logger.warn({
      event: 'payment_paid_after_cancel',
      message: `order ${row.id} was paid while ${row.status}; the consumer must refund it`,
      orderId: row.id,
      status: row.status,
      source: cause,
    });
    await this.audit.record({
      tenantId,
      ...auditActorOf(context),
      action: 'payment.paid_after_cancel',
      resourceType: 'payment_order',
      resourceId: row.id,
      metadata: {
        orderId: row.id,
        status: row.status,
        outcome: 'LATE_PAYMENT_ON_CANCELLED',
        netpayTransactionId: row.netpayTransactionId,
        event: PAYMENT_EVENTS.PAID_AFTER_CANCEL,
        source: cause,
      },
    });
  }

  /**
   * The body of {@link applyStatus}, inside a transaction the caller owns: the
   * order change, its attempt, anything else the caller writes with it, and the
   * event. Nothing is reported; the caller does that after the commit.
   *
   * @param client Tenant transaction.
   * @param id Order id.
   * @param status New status.
   * @param now Time of the change.
   * @param extra Additional columns.
   * @param change Tenant, forced event, attempt and companion writes.
   * @returns The updated row, the status before it and the event written, if any.
   */
  private async applyStatusIn(
    client: TenantClient,
    id: string,
    status: PaymentStatus,
    now: Date,
    extra: Record<string, unknown>,
    change: StatusChangeOptions,
  ): Promise<StatusChange> {
    const current = await client.paymentOrder.update({
      where: { id },
      data: { updatedAt: now },
      select: { status: true, paidAfterCancelAt: true },
    });
    if (change.expectFrom !== undefined && !change.expectFrom.includes(current.status)) {
      throw new StaleTransitionError(current.status);
    }
    if (TERMINAL_UNPAID_STATUSES.includes(current.status) && current.status !== status) {
      if (status !== STATUS_PAID) {
        // A cancelled or expired order is not reopened by anything Netpay says,
        // short of money having moved.
        throw new StaleTransitionError(current.status);
      }
      return this.recordLatePaymentIn(client, id, current, now, extra, change);
    }
    const row = await client.paymentOrder.update({
      where: { id },
      data: {
        status,
        sequence: { increment: current.status === status ? 0 : 1 },
        updatedAt: now,
        ...extra,
      },
      select: this.orderSelect(),
    });
    if (change.attempt !== undefined) {
      await this.recordAttempt(client, id, change.attempt, now);
    }
    if (change.also !== undefined) {
      await change.also(client);
    }
    const eventType = change.event ?? eventForTransition(current.status, row.status);
    if (eventType !== null) {
      await this.events.record(client, {
        eventType,
        tenantId: change.tenantId,
        previousStatus: current.status,
        order: row,
        occurredAt: now,
        ...(change.refunded === undefined ? {} : { refunded: change.refunded }),
      });
    }
    return { row, previousStatus: current.status, emittedEvent: eventType };
  }

  /**
   * Records a payment Netpay confirmed for a CANCELLED or EXPIRED order
   * (BN-REQ-PAY-004), inside the change's transaction.
   *
   * The merchant's decision stands: the status does not change. The transaction,
   * the verified amount and `paidAfterCancelAt` are written, the claim goes, and
   * `payment.paid_after_cancel` is emitted the first time only, so the consumer
   * learns once that it has money to give back.
   *
   * @param client Tenant transaction.
   * @param id Order id.
   * @param current Status and late-payment stamp read under the row lock.
   * @param now Time of the change.
   * @param extra Columns the settled verification would have written.
   * @param change Tenant and attempt.
   * @returns The change, flagged `latePayment` when it was recorded now.
   */
  private async recordLatePaymentIn(
    client: TenantClient,
    id: string,
    current: { status: PaymentStatus; paidAfterCancelAt: Date | null },
    now: Date,
    extra: Record<string, unknown>,
    change: StatusChangeOptions,
  ): Promise<StatusChange> {
    const first = current.paidAfterCancelAt === null;
    const kept: Record<string, unknown> = {};
    for (const key of ['netpayTransactionId', 'verifiedAmount', 'lastVerifiedAt', 'paymentMethod']) {
      if (key in extra) {
        kept[key] = extra[key];
      }
    }
    const row = await client.paymentOrder.update({
      where: { id },
      data: {
        ...kept,
        operationClaim: null,
        operationClaimedAt: null,
        updatedAt: now,
        ...(first ? { paidAfterCancelAt: now } : {}),
      },
      select: this.orderSelect(),
    });
    if (change.attempt !== undefined) {
      await this.recordAttempt(client, id, change.attempt, now);
    }
    if (!first) {
      return { row, previousStatus: current.status, emittedEvent: null };
    }
    await this.events.record(client, {
      eventType: PAYMENT_EVENTS.PAID_AFTER_CANCEL,
      tenantId: change.tenantId,
      previousStatus: current.status,
      order: row,
      occurredAt: now,
    });
    return {
      row,
      previousStatus: current.status,
      emittedEvent: PAYMENT_EVENTS.PAID_AFTER_CANCEL,
      latePayment: true,
    };
  }

  /**
   * Writes a charge attempt (BN-REQ-PAY-001/002).
   *
   * A new attempt is numbered after the last one of the order; the claim makes this
   * the only writer, and the unique `(orderId, attemptNo)` index refuses a second
   * one regardless. A settled verification updates the attempt holding the
   * transaction, or the UNKNOWN one that just learnt it.
   *
   * @param client Tenant transaction.
   * @param orderId Order.
   * @param attempt What to write.
   * @param now Time of the change.
   */
  private async recordAttempt(
    client: TenantClient,
    orderId: string,
    attempt: AttemptChange,
    now: Date,
  ): Promise<void> {
    if (attempt.kind === 'settle') {
      await client.paymentAttempt.updateMany({
        where: {
          orderId,
          OR: [
            { netpayTransactionId: attempt.transactionId },
            { netpayTransactionId: null, status: ATTEMPT.UNKNOWN },
          ],
        },
        data: {
          netpayTransactionId: attempt.transactionId,
          status: attempt.status,
          ...(attempt.declineCode === undefined ? {} : { declineCode: attempt.declineCode }),
        },
      });
      return;
    }
    const last = await client.paymentAttempt.findFirst({
      where: { orderId },
      orderBy: { attemptNo: 'desc' },
      select: { attemptNo: true },
    });
    await client.paymentAttempt.create({
      data: {
        id: randomUUID(),
        orderId,
        attemptNo: (last?.attemptNo ?? (attempt.legacyBound ? 1 : 0)) + 1,
        netpayTransactionId: attempt.transactionId,
        status: attempt.status,
        declineCode: attempt.declineCode ?? null,
        createdAt: now,
      },
    });
  }

  /**
   * Reports a committed status change: the `payment_status_change` log line the
   * metrics read (BN-REQ-OPS-005) and the audit record (BN-REQ-OPS-011).
   *
   * Runs after the commit, so neither can describe a change that rolled back. The
   * audit service never throws into the caller.
   *
   * @param orderId Order.
   * @param from Previous status, `null` on creation.
   * @param to New status.
   * @param tenantId Tenant.
   * @param eventType Event written with the change, if any.
   */
  private async statusChanged(
    orderId: string,
    from: string | null,
    to: string,
    tenantId: string,
    eventType: string | null,
    cause?: string,
  ): Promise<void> {
    const context = this.requestContext.get();
    // No principal: the unsigned notification caused it, unless the caller says
    // which worker did (reconciliation).
    const source = cause ?? (context.principal ? 'api' : 'webhook');
    logPaymentStatusChange(this.logger, { orderId, from, to, source });
    await this.audit.record({
      tenantId,
      ...auditActorOf(context),
      action: 'payment.status_changed',
      resourceType: 'payment_order',
      resourceId: orderId,
      metadata: { orderId, from, to, event: eventType, source },
    });
  }

  /**
   * Validates and normalises a caller-supplied amount.
   *
   * @param raw Amount as sent.
   * @returns Two-decimal string, or `null` when unusable.
   */
  private normaliseAmount(raw: string): string | null {
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw.trim())) {
      return null;
    }
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return value.toFixed(2);
  }

  /**
   * The tenant this service operates for.
   *
   * @returns Tenant id.
   */
  private currentTenantId(): string {
    const tenant = this.requestContext.get().tenant;
    if (!tenant) {
      throw new ValidationException('No tenant is resolved for this request.');
    }
    return tenant.id;
  }

  /**
   * Column selection shared by every read.
   *
   * @returns Prisma select.
   */
  private orderSelect() {
    return {
      id: true,
      sequence: true,
      orderReference: true,
      merchantReferenceCode: true,
      amount: true,
      currency: true,
      status: true,
      netpayTransactionId: true,
      amountToken: true,
      failureReason: true,
      failureCode: true,
      checkoutMode: true,
      paymentMethod: true,
      paymentReference: true,
      paymentReferenceExpiresAt: true,
      refundedAmount: true,
      verifiedAmount: true,
      paidAfterCancelAt: true,
      configId: true,
      createdAt: true,
      updatedAt: true,
    };
  }

  /**
   * Maps a row to the public view.
   *
   * @param row Selected row.
   * @returns The view.
   */
  private toView(row: {
    id: string;
    orderReference: string;
    merchantReferenceCode: string;
    amount: Prisma.Decimal;
    currency: string;
    status: string;
    netpayTransactionId: string | null;
    amountToken: string | null;
    failureReason: string | null;
    failureCode?: string | null;
    paymentMethod: string | null;
    paymentReference: string | null;
    paymentReferenceExpiresAt: Date | null;
    refundedAmount: Prisma.Decimal;
    verifiedAmount?: Prisma.Decimal | null;
    paidAfterCancelAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentOrderView {
    return {
      id: row.id,
      orderReference: row.orderReference,
      merchantReferenceCode: row.merchantReferenceCode,
      amount: row.amount.toFixed(2),
      currency: row.currency,
      status: row.status,
      netpayTransactionId: row.netpayTransactionId,
      paymentMethod: row.paymentMethod,
      paymentReference: row.paymentReference,
      paymentReferenceExpiresAt: row.paymentReferenceExpiresAt?.toISOString() ?? null,
      refundedAmount: row.refundedAmount.toFixed(2),
      checkout: null,
      failureReason: row.failureReason,
      failureCode: row.failureCode ?? null,
      verifiedAmount: row.verifiedAmount?.toFixed(2) ?? null,
      paidAfterCancelAt: row.paidAfterCancelAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Builds the storefront-facing checkout configuration.
   *
   * Carries the public key and the amount token, never the secret. The amount
   * itself is included for display only; the token is what the provider settles.
   *
   * @param config Tenant provider configuration.
   * @param order Reference, merchant code, amount and currency of the order.
   * @returns The checkout configuration.
   */
  private checkoutConfig(
    config: { publicKey: string; environment: NetpayEnvironment },
    order: {
      orderReference: string;
      merchantReferenceCode: string;
      amount: string;
      currency: string;
      mode: CheckoutMode;
      /** Token produced for this order; null outside `plus`. */
      amountToken: string | null;
      /** Netpay's payment page; null outside `hosted`. */
      hostedCheckoutUrl: string | null;
    },
  ): NonNullable<PaymentOrderView['checkout']> {
    return {
      mode: order.mode,
      environment: config.environment,
      publicKey: config.publicKey,
      amountToken: order.amountToken,
      hostedCheckoutUrl: order.hostedCheckoutUrl,
      merchantReferenceCode: order.merchantReferenceCode,
      amount: order.amount,
      currency: order.currency,
      // The button must run in sandbox mode while the merchant is on the sandbox
      // keys; deriving it here avoids a storefront that silently charges live.
      sandboxMode: config.environment === 'SANDBOX',
      redirectUrl: paymentUrls().redirectUrl,
      cancelUrl: paymentUrls().cancelUrl,
    };
  }
}

/** Re-exported for the module's provider list. */
export type { NetpayEnvironment };

/**
 * Device fields Netpay requires on a charge, all produced by
 * `NetPay.form.deviceInformation()` in the buyer's browser.
 */
const REQUIRED_DEVICE_FIELDS = [
  'deviceChannel',
  'httpBrowserColorDepth',
  'httpBrowserJavaEnabled',
  'httpBrowserJavaScriptEnabled',
  'httpBrowserLanguage',
  'httpBrowserScreenHeight',
  'httpBrowserScreenWidth',
  'httpBrowserTimeDifference',
] as const;

/**
 * Reads a Netpay expiration date.
 *
 * Netpay reports `2026-10-17T23:59:59` without a zone, in Mexico City time (UTC-6,
 * the country dropped DST). Falls back to now plus the requested days when the
 * answer is missing or unreadable.
 *
 * @param value Date string as received.
 * @param fallbackDays Days to use when the value is unusable.
 * @returns The instant the reference stops being payable.
 */
function parseNetpayLocalDate(value: unknown, fallbackDays: number): Date {
  if (typeof value === 'string') {
    const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}-06:00`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(Date.now() + fallbackDays * 86_400_000);
}
