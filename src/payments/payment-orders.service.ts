import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/tenant-plane/client';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { PaymentConfigService } from './payment-config.service';
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
} from './netpay-endpoints';
import { PAYMENT_EVENTS, PaymentEvents } from './payment-events';
import { ConflictException, NotFoundException, ValidationException } from '../common/errors/app.exception';

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
  readonly createdAt: string;
  readonly updatedAt: string;
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
const STATUS_PAID = 'PAID';

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
    const orderReference = PaymentConfigService.newOrderReference(config.orderReferencePrefix);
    const currency = (input.currency ?? 'MXN').toUpperCase();

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

    let amountToken: string | null = null;
    let hostedCheckoutUrl: string | null = null;
    let cashReference: { reference: NetpayOxxoReference; expiresAt: Date } | null = null;
    try {
      if (checkoutMode === 'hosted') {
        // Netpay hosts the payment page and answers with its URL. The merchant
        // reference sent is the order reference, which is unique, so a retry can
        // never clash with an earlier session.
        const successUrl = input.successUrl ?? process.env['PAYMENT_REDIRECT_URL'];
        const cancelUrl = input.cancelUrl ?? process.env['PAYMENT_CANCEL_URL'];
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
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findFirst({ where: { id }, select: this.orderSelect() }),
    );
    if (row === null) {
      // Same answer as "exists but belongs to another tenant": confirming the
      // difference would be an existence oracle across tenants.
      throw new NotFoundException('The requested resource was not found.');
    }
    return this.toView(row);
  }

  /**
   * Lists orders for the current tenant.
   *
   * @param limit Page size, clamped.
   * @returns Recent orders.
   */
  async list(limit: number): Promise<PaymentOrderView[]> {
    const take = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);
    const rows = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findMany({ orderBy: { createdAt: 'desc' }, take, select: this.orderSelect() }),
    );
    return rows.map((row) => this.toView(row));
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
    if (existing.status === STATUS_PAID) {
      // Already settled. Re-verifying a paid order must be a no-op: otherwise a
      // redelivered notification rewrites the row and bumps its sequence.
      return { orderId, status: existing.status, changed: false, emittedEvent: null };
    }

    const config = await this.config.getUsableInSchema(schemaName);
    const transaction = await this.netpay.getTransaction(config.environment, config.secretKey, transactionId);

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

    const expected = existing.amount.toFixed(2);
    const reported = toAmountString(transaction.amount);
    const status = parseStatus(transaction.status);
    const now = new Date();

    if (reported !== null && reported !== expected) {
      // Never marked paid on a mismatch, whatever Netpay's status says.
      const updated = await this.applyStatus(schemaName, existing.id, 'AMOUNT_MISMATCH', now, {
        netpayTransactionId: transactionId,
        verifiedAmount: new Prisma.Decimal(reported),
        failureReason: 'Amount reported by the provider does not match the order.',
      });
      return {
        orderId,
        status: updated.status,
        changed: updated.status !== existing.status,
        emittedEvent: this.events.emitIfChanged(
          existing.status,
          updated.status,
          updated,
          schemaName,
          tenantId,
        ),
      };
    }

    if (status !== null && PROVIDER_SETTLED.has(status)) {
      const updated = await this.applyStatus(schemaName, existing.id, STATUS_PAID, now, {
        netpayTransactionId: transactionId,
        verifiedAmount: reported === null ? null : new Prisma.Decimal(reported),
        lastVerifiedAt: now,
        // Cash when the order carries a cash reference, card otherwise.
        paymentMethod:
          existing.paymentReference !== null || existing.checkoutMode === 'oxxo' ? 'OXXO' : 'CARD',
        failureReason: null,
      });
      return {
        orderId,
        status: updated.status,
        changed: true,
        emittedEvent: this.events.emitIfChanged(
          existing.status,
          updated.status,
          updated,
          schemaName,
          tenantId,
        ),
      };
    }

    if (status !== null && FAILED_STATUSES.includes(status)) {
      const updated = await this.applyStatus(schemaName, existing.id, 'FAILED', now, {
        netpayTransactionId: transactionId,
        lastVerifiedAt: now,
        failureReason: 'The provider reported the charge as unsuccessful.',
      });
      return {
        orderId,
        status: updated.status,
        changed: updated.status !== existing.status,
        emittedEvent: this.events.emitIfChanged(
          existing.status,
          updated.status,
          updated,
          schemaName,
          tenantId,
        ),
      };
    }

    // `IN_PROCESS`, or a status we do not recognise: nothing is concluded.
    const updated = await this.applyStatus(schemaName, existing.id, 'PENDING_VERIFICATION', now, {
      netpayTransactionId: transactionId,
      lastVerifiedAt: now,
    });
    return { orderId, status: updated.status, changed: false, emittedEvent: null };
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
      // Only the last four digits, which is what a receipt legitimately needs.
      lastFourDigits: input.cardToken?.slice(-4) ?? null,
    };
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
    const existing = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentOrder.findFirst({ where: { id: orderId }, select: this.orderSelect() }),
    );
    if (existing === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    if (existing.status === STATUS_PAID) {
      throw new ConflictException('This order is already settled.');
    }
    if (existing.netpayTransactionId !== null && existing.status !== 'FAILED') {
      // A charge was already submitted and the provider has not reported it
      // unsuccessful. Charging again would bill the buyer twice.
      throw new ConflictException('A charge for this order is already awaiting confirmation.');
    }
    const amount = existing.amount.toFixed(2);
    if (input.installments !== undefined) {
      const rejection = msiRejection(input.installments, amount, input.cardBrand);
      if (rejection !== null) {
        throw new ValidationException(rejection);
      }
    }
    const config = await this.config.getUsable();
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const tenantId = this.currentTenantId();
    // The fingerprint and the session id are one value: the one the browser
    // produced while tokenising. Netpay's 3DS 2.0 fails without it, so there is
    // no generated fallback.
    const sessionId = input.deviceFingerPrint;
    // Claimed before the provider is called: without it, two concurrent requests
    // both pass the checks above and the buyer is charged twice.
    //
    // `netpayTransactionId: null` closes the window the claim alone leaves open.
    // The claim is released as soon as the charge returns and the transaction
    // id is written, but the status is settled only afterwards, so in between
    // the order is unclaimed and still looks chargeable. Requiring that no
    // transaction is bound makes that state unchargeable, which is what a
    // second charge actually needs to be refused. It is also what keeps a 3-D
    // Secure order from being charged twice while its challenge is still open:
    // the provider already created a transaction for it.
    await this.claimOrder(existing.id, 'charge', {
      status: { notIn: [STATUS_PAID, 'REFUNDED'] },
      netpayTransactionId: null,
    });
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
      const transaction = await this.netpay.createCharge(
        config.environment,
        config.secretKey,
        body,
        input.userAgent,
      );
      if (createdProfile && input.saveCard !== true) {
        await this.discardTransientCard(config, clientId, input.cardToken);
      }
      await this.tenantPrisma.forCurrentTenantTransaction((client) =>
        client.paymentOrder.update({
          where: { id: existing.id },
          data: {
            ...(typeof transaction.transactionTokenId === 'string'
              ? { netpayTransactionId: transaction.transactionTokenId }
              : {}),
            ...(input.saveCard === true ? { netpayCustomerId: clientId } : {}),
            operationClaim: null,
            operationClaimedAt: null,
            updatedAt: new Date(),
          },
        }),
      );
      // The provider decides the outcome, and it already knows it: asking now
      // settles the order without waiting for a notification, which matters where
      // Netpay cannot reach this server. A failure here changes nothing; the
      // notification, or a later retry, still concludes the order.
      let orderStatus: string = existing.status;
      const outcome = parseStatus(transaction.status);
      if (
        typeof transaction.transactionTokenId === 'string' &&
        outcome !== null &&
        FAILED_STATUSES.includes(outcome)
      ) {
        // A decline comes from Netpay's own authenticated answer to this request,
        // not from an unsigned notification, so it is recorded at once. Waiting for a
        // verification that may fail would leave the order looking "in progress"
        // and refuse the buyer's retry with another card.
        const updated = await this.applyStatus(schemaName, existing.id, 'FAILED', new Date(), {
          lastVerifiedAt: new Date(),
          failureReason: transaction.declineReason ?? 'The provider declined the charge.',
        });
        this.events.emitIfChanged(existing.status, updated.status, updated, schemaName, tenantId);
        orderStatus = updated.status;
      } else if (typeof transaction.transactionTokenId === 'string') {
        try {
          const result = await this.verifyOrderInSchema(
            schemaName,
            existing.id,
            transaction.transactionTokenId,
            tenantId,
          );
          orderStatus = result.status;
        } catch {
          this.logger.warn(`Could not verify order ${existing.id} right after the charge.`);
        }
      }
      // Netpay echoes the whole request back, including the CVV and the card
      // details, so only what a storefront needs is returned.
      return {
        transactionTokenId: transaction.transactionTokenId ?? null,
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
      };
    } catch (error) {
      await this.releaseClaim(existing.id);
      throw error;
    }
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
    // A partly refunded order is still PAID: only the full amount turns it REFUNDED.
    if (existing.status !== STATUS_PAID) {
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
    const config = await this.config.getUsable();
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const tenantId = this.currentTenantId();
    // Claimed before the provider is called: two concurrent refunds would both
    // see a settled order and both reverse the transaction.
    await this.claimOrder(existing.id, 'refund', { status: STATUS_PAID });
    try {
      await this.reverseAtProvider(
        config,
        existing.netpayTransactionId,
        requested,
        motive,
        existing.refundedAmount.isZero() && requested.equals(existing.amount),
      );
    } catch (error) {
      await this.releaseClaim(existing.id);
      throw error;
    }
    // The reversal happened, so the claim is cleared together with the new total.
    const total = existing.refundedAmount.plus(requested);
    const full = total.greaterThanOrEqualTo(existing.amount);
    const updated = await this.applyStatus(
      schemaName,
      existing.id,
      full ? 'REFUNDED' : STATUS_PAID,
      new Date(),
      {
        refundedAmount: total,
        failureReason: null,
        operationClaim: null,
        operationClaimedAt: null,
      },
    );
    // `payment.refunded` fires for a partial refund too, which does not change the
    // status, so it is emitted explicitly rather than through `emitIfChanged`.
    this.events.emit(PAYMENT_EVENTS.REFUNDED, updated, schemaName, tenantId, {
      refunded: requested.toFixed(2),
      fullyRefunded: full,
    });
    return { status: updated.status, refundedAmount: total.toFixed(2), refunded: requested.toFixed(2) };
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
        where: { id: orderId, paymentReference: null, status: { notIn: [STATUS_PAID, 'REFUNDED'] } },
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
    if (existing.status === STATUS_PAID) {
      throw new ConflictException('This order is already settled.');
    }
    const config = await this.config.getUsable();
    const transaction = await this.netpay.getTransaction(
      config.environment,
      config.secretKey,
      existing.netpayTransactionId,
    );
    if (parseStatus(transaction.status) !== 'WAIT_THREEDS') {
      throw new ConflictException('The transaction is not waiting for 3-D Secure confirmation.');
    }
    await this.claimOrder(existing.id, 'confirm', { status: { notIn: [STATUS_PAID, 'REFUNDED'] } });
    try {
      await this.netpay.confirmCharge(
        config.environment,
        config.secretKey,
        existing.netpayTransactionId,
        processorTransactionId,
      );
    } finally {
      await this.releaseClaim(existing.id);
    }
    const result = await this.verifyOrderInSchema(
      this.tenantPrisma.requireCurrentSchema(),
      existing.id,
      existing.netpayTransactionId,
      this.currentTenantId(),
    );
    return { status: result.status };
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
    operation: 'refund' | 'charge' | 'confirm',
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
   * Writes a status, bumping the per-order sequence subscribers use to spot gaps.
   *
   * @param schemaName Tenant schema.
   * @param id Order id.
   * @param status New status.
   * @param now Timestamp.
   * @param extra Additional columns.
   * @returns The updated row.
   */
  private async applyStatus(
    schemaName: string,
    id: string,
    status: string,
    now: Date,
    extra: Record<string, unknown> = {},
  ): Promise<{
    id: string;
    status: string;
    sequence: number;
    orderReference: string;
    merchantReferenceCode: string;
    amount: Prisma.Decimal;
    currency: string;
    netpayTransactionId: string | null;
    amountToken: string | null;
    failureReason: string | null;
    paymentMethod: string | null;
    paymentReference: string | null;
    paymentReferenceExpiresAt: Date | null;
    refundedAmount: Prisma.Decimal;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.tenantPrisma.forTenantTransaction(schemaName, async (client) => {
      const current = await client.paymentOrder.findFirstOrThrow({
        where: { id },
        select: { status: true, sequence: true },
      });
      return client.paymentOrder.update({
        where: { id },
        data: {
          status: status as never,
          sequence: { increment: current.status === status ? 0 : 1 },
          updatedAt: now,
          ...extra,
        },
        select: this.orderSelect(),
      });
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
      checkoutMode: true,
      paymentMethod: true,
      paymentReference: true,
      paymentReferenceExpiresAt: true,
      refundedAmount: true,
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
    paymentMethod: string | null;
    paymentReference: string | null;
    paymentReferenceExpiresAt: Date | null;
    refundedAmount: Prisma.Decimal;
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
      redirectUrl: process.env['PAYMENT_REDIRECT_URL'] ?? 'https://localhost/',
      cancelUrl: process.env['PAYMENT_CANCEL_URL'] ?? 'https://localhost/',
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
