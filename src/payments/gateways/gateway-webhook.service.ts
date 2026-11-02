import { Injectable, Logger } from '@nestjs/common';
import { PaymentOrdersService } from '../payment-orders.service';
import { PaymentGatewaysService } from './payment-gateways.service';
import { PaymentSecretBox } from '../payment-secret-box';
import {
  STRIPE_ORDER_METADATA_KEY,
  type KeysGatewayProvider,
  verifyMercadoPagoSignature,
  verifyStripeSignature,
} from './gateway-endpoints';

/** Stripe events that can move an order. */
const STRIPE_ORDER_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
]);

/** The parts of a Stripe event this service reads. */
interface StripeEvent {
  readonly type?: string;
  readonly account?: string;
  readonly data?: {
    readonly object?: {
      readonly id?: string;
      readonly object?: string;
      readonly payment_intent?: string | null;
      readonly metadata?: Record<string, string>;
    };
  };
}

/**
 * Inbound gateway webhooks (docs 33).
 *
 * Stripe and Mercado Pago sign theirs, and the signature is checked first;
 * Conekta and Openpay are routed by an opaque per-tenant token. Either way the
 * body is only a pointer. The tenant comes from the control-plane route of the account the
 * event names, the order from the tenant's own rows, and the payment from the
 * gateway's API, applied through the same verification as Netpay. Every outcome
 * looks the same to the caller.
 */
@Injectable()
export class GatewayWebhookService {
  private readonly logger = new Logger(GatewayWebhookService.name);

  constructor(
    private readonly gateways: PaymentGatewaysService,
    private readonly orders: PaymentOrdersService,
  ) {}

  /**
   * Handles one Stripe Connect event.
   *
   * @param rawBody Body exactly as received (the signature covers it).
   * @param signature `Stripe-Signature`.
   */
  async receiveStripe(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    const secret = this.gateways.platform.stripe?.webhookSecret;
    if (
      secret === undefined ||
      rawBody === undefined ||
      !verifyStripeSignature(rawBody, signature, secret, Date.now())
    ) {
      this.logger.warn({ event: 'gateway_webhook_rejected', provider: 'STRIPE' });
      return;
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    } catch {
      return;
    }
    // A non-Connect endpoint (platform-account mode) carries no `account`: the event
    // belongs to the platform account itself. In Connect mode it is dropped.
    let account: string;
    if (typeof event.account === 'string') {
      account = event.account;
    } else if (this.gateways.stripePlatformMode()) {
      try {
        account = await this.gateways.platformAccountId();
      } catch {
        return;
      }
    } else {
      return;
    }
    const scope = await this.gateways.resolveRoute('STRIPE', account);
    if (scope === null) {
      this.logger.warn({ event: 'gateway_webhook_unrouted', provider: 'STRIPE' });
      return;
    }
    if (event.type === 'account.application.deauthorized') {
      await this.gateways.markDeauthorized(scope, account);
      return;
    }
    if (event.type === undefined || !STRIPE_ORDER_EVENTS.has(event.type)) {
      return;
    }
    const object = event.data?.object ?? {};
    const isSession = object.object === 'checkout.session';
    // A session or a charge points at its PaymentIntent; a PaymentIntent is one.
    const intentId = object.object === 'payment_intent' ? object.id : (object.payment_intent ?? undefined);
    const orderId = await this.orders.findGatewayOrderIdInSchema(scope.schemaName, 'STRIPE', {
      ...(isSession && object.id !== undefined ? { checkoutSessionId: object.id } : {}),
      ...(object.metadata?.[STRIPE_ORDER_METADATA_KEY] === undefined
        ? {}
        : { orderReference: object.metadata[STRIPE_ORDER_METADATA_KEY] }),
      ...(intentId === undefined ? {} : { netpayTransactionId: intentId }),
    });
    if (orderId === null) {
      return;
    }
    await this.verify(scope.schemaName, orderId, scope.tenantId, intentId ?? null, 'STRIPE');
  }

  /**
   * Handles one Mercado Pago notification.
   *
   * @param input Signature headers, the `data.id` query parameter and the body.
   */
  async receiveMercadoPago(input: {
    signature: string | undefined;
    requestId: string | undefined;
    queryDataId: string | undefined;
    body: { type?: string; user_id?: number | string; data?: { id?: string | number } } | undefined;
  }): Promise<void> {
    const secret = this.gateways.platform.mercadoPago?.webhookSecret;
    const dataId =
      input.queryDataId ?? (input.body?.data?.id === undefined ? undefined : String(input.body.data.id));
    if (
      secret === undefined ||
      !verifyMercadoPagoSignature({ signature: input.signature, requestId: input.requestId, dataId, secret })
    ) {
      this.logger.warn({ event: 'gateway_webhook_rejected', provider: 'MERCADOPAGO' });
      return;
    }
    const userId = input.body?.user_id;
    if (
      input.body?.type !== 'payment' ||
      dataId === undefined ||
      !/^\d+$/.test(dataId) ||
      userId === undefined
    ) {
      return;
    }
    const scope = await this.gateways.resolveRoute('MERCADOPAGO', String(userId));
    if (scope === null) {
      this.logger.warn({ event: 'gateway_webhook_unrouted', provider: 'MERCADOPAGO' });
      return;
    }
    // Mercado Pago orders are stored under MERCADOPAGO (searching another provider never matches).
    // Only the id is taken from the notification: the payment itself, and the
    // reference that names its order, come from Mercado Pago with the seller's token.
    let reference: string | null;
    try {
      const found = await this.gateways.lookup(scope, 'MERCADOPAGO', {
        transactionId: dataId,
        sessionId: null,
        orderReference: '',
      });
      reference =
        typeof found?.transaction.merchantReferenceCode === 'string'
          ? found.transaction.merchantReferenceCode
          : null;
    } catch (error) {
      this.logger.warn({ event: 'gateway_webhook_failed', provider: 'MERCADOPAGO', message: String(error) });
      return;
    }
    if (reference === null) {
      return;
    }
    const orderId = await this.orders.findGatewayOrderIdInSchema(scope.schemaName, 'MERCADOPAGO', {
      orderReference: reference,
    });
    if (orderId !== null) {
      await this.verify(scope.schemaName, orderId, scope.tenantId, dataId, 'MERCADOPAGO');
    }
  }

  /**
   * Handles one Conekta / Openpay notification (D10).
   *
   * Neither signs with a usable shared secret, so, like Netpay, the opaque token in
   * the URL is what names the tenant, and the body only contributes ids: the order
   * (Conekta) or charge (Openpay) is fetched again from the gateway with the
   * tenant's key before anything changes.
   *
   * @param provider `CONEKTA` or `OPENPAY`.
   * @param token Opaque token from the URL.
   * @param body Notification body.
   */
  async receiveWithToken(provider: KeysGatewayProvider, token: string, body: unknown): Promise<void> {
    const scope = await this.gateways.resolveRoute(provider, PaymentSecretBox.hashToken(token));
    if (scope === null) {
      this.logger.warn({ event: 'gateway_webhook_unrouted', provider });
      return;
    }
    const payload = (body ?? {}) as {
      type?: string;
      verification_code?: string;
      transaction?: { id?: unknown; order_id?: unknown };
      data?: { object?: { id?: unknown; object?: unknown; order_id?: unknown } };
    };
    let transactionId: string | null = null;
    let orderReference: string | undefined;
    if (provider === 'CONEKTA') {
      const object = payload.data?.object ?? {};
      const id = object.object === 'order' ? object.id : object.order_id;
      transactionId = typeof id === 'string' ? id : null;
    } else {
      if (payload.type === 'verification') {
        // Openpay proves the URL with a code the merchant types into its dashboard.
        this.logger.log({
          event: 'openpay_webhook_verification',
          tenantId: scope.tenantId,
          code: payload.verification_code,
        });
        return;
      }
      transactionId = typeof payload.transaction?.id === 'string' ? payload.transaction.id : null;
      orderReference =
        typeof payload.transaction?.order_id === 'string' ? payload.transaction.order_id : undefined;
    }
    if (transactionId === null) {
      return;
    }
    const orderId = await this.orders.findGatewayOrderIdInSchema(scope.schemaName, provider, {
      checkoutSessionId: transactionId,
      netpayTransactionId: transactionId,
      ...(orderReference === undefined ? {} : { orderReference }),
    });
    if (orderId !== null) {
      await this.verify(scope.schemaName, orderId, scope.tenantId, transactionId, provider);
    }
  }

  private async verify(
    schemaName: string,
    orderId: string,
    tenantId: string,
    transactionId: string | null,
    provider: string,
  ): Promise<void> {
    try {
      const result = await this.orders.verifyGatewayOrderInSchema(
        schemaName,
        orderId,
        tenantId,
        transactionId,
        'webhook',
      );
      this.logger.log({ event: 'gateway_webhook_verified', provider, orderId, status: result.status });
    } catch (error) {
      // Logged, never reflected: the caller gets the same answer either way, and
      // reconciliation picks the order up again.
      this.logger.warn({ event: 'gateway_webhook_failed', provider, orderId, message: String(error) });
    }
  }
}
