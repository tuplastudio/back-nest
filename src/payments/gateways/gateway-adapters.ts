import { ValidationException } from '../../common/errors/app.exception';
import type { NetpayTransaction } from '../netpay-endpoints';
import {
  STRIPE_ORDER_METADATA_KEY,
  conektaOrderToTransaction,
  mercadoPagoPaymentToTransaction,
  openpayChargeToTransaction,
  stripeIntentToTransaction,
  stripeSavedCard,
  toCents,
  toStripeForm,
  type ConektaOrder,
  type GatewayProvider,
  type GatewaySavedCard,
  type KeysGatewayProvider,
  type MercadoPagoPayment,
  type OpenpayCharge,
  type StripeForm,
  type StripePaymentIntent,
} from './gateway-endpoints';

/**
 * One adapter per alternative gateway (docs 33): the only place that knows a
 * gateway's URLs, payload shapes and statuses. `PaymentGatewaysService` resolves
 * the account and its secret, hands the adapter an authenticated call, and the
 * adapter answers in the shared vocabulary (a Netpay-shaped transaction), so the
 * order lifecycle never branches per gateway.
 */

export const STRIPE_API = 'https://api.stripe.com';
export const MP_API = 'https://api.mercadopago.com';
export const CONEKTA_API = 'https://api.conekta.io';
const OPENPAY_API = { SANDBOX: 'https://sandbox-api.openpay.mx', LIVE: 'https://api.openpay.mx' } as const;
const CONEKTA_ACCEPT = 'application/vnd.conekta-v2.1.0+json';

/** Sends one request; 4xx / 5xx / no answer are classified by the service. */
export type GatewayHttp = <T>(
  url: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: string },
) => Promise<T>;

/** What an adapter is handed for one operation. */
export interface GatewayCall {
  /** `acct_…`, MP `user_id`, Conekta public key, Openpay merchant id. */
  readonly externalAccountId: string;
  readonly environment: 'SANDBOX' | 'LIVE';
  /** Stripe platform key, MP seller token, Conekta / Openpay private key. */
  readonly secret: string;
  /** Stripe platform-account mode: the platform is the merchant, so no `Stripe-Account` header. */
  readonly stripePlatformMode?: boolean;
  readonly http: GatewayHttp;
}

/** A gateway transaction mapped for verification, plus the card it saved, if any. */
export interface GatewayLookup {
  readonly transactionId: string;
  readonly transaction: NetpayTransaction;
  readonly savedCard: GatewaySavedCard | null;
}

/** What a hosted checkout is created from. */
export interface HostedCheckoutInput {
  readonly orderReference: string;
  readonly title: string;
  readonly amount: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly saveCard: boolean;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  /** Where the gateway notifies this order, when it takes a per-order URL (Mercado Pago). */
  readonly notificationUrl: string | null;
  readonly buyer: { readonly name: string; readonly email: string; readonly phone?: string } | null;
}

/** Keys a tenant pastes for a keys gateway (D8). */
export interface GatewayKeys {
  readonly privateKey: string;
  readonly publicKey: string;
  /** Openpay only. */
  readonly merchantId?: string;
  /** Openpay only (the API host differs per environment). */
  readonly environment?: 'SANDBOX' | 'LIVE';
}

/** What every gateway does for an order. */
export interface GatewayAdapter {
  readonly auth: 'oauth' | 'keys';
  readonly supportsAutopay: boolean;
  createCheckout(call: GatewayCall, input: HostedCheckoutInput): Promise<{ sessionId: string; url: string }>;
  /**
   * What the gateway knows about an order's payment, by transaction or else by
   * the hosted checkout / reference. `null` while the buyer has not attempted it.
   */
  lookup(
    call: GatewayCall,
    ref: { transactionId: string | null; sessionId: string | null; orderReference: string },
  ): Promise<GatewayLookup | null>;
  refund(call: GatewayCall, transactionId: string, amount: string, idempotencyKey: string): Promise<void>;
}

/** A gateway connected with the tenant's own keys, notified on a per-tenant token URL (D8, D10). */
export interface KeysGatewayAdapter extends GatewayAdapter {
  /** Proves the keys against the API; the account fields to store. */
  validateKeys(
    http: GatewayHttp,
    keys: GatewayKeys,
  ): Promise<{ externalAccountId: string; environment: 'SANDBOX' | 'LIVE'; publicKey: string }>;
  /** Registers the webhook URL; the gateway's id for it. */
  registerWebhook(call: GatewayCall, url: string): Promise<string>;
  deleteWebhook(call: GatewayCall, webhookId: string): Promise<void>;
}

/**
 * Refuses an id that is about to be placed in a gateway URL path.
 *
 * @param value Id.
 * @param pattern Accepted shape.
 * @returns The id.
 */
function pathId(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new ValidationException('The gateway transaction id is not valid.');
  }
  return value;
}

/** HTTP Basic with the private key as user and no password (Conekta, Openpay). */
function basic(secret: string): string {
  return `Basic ${Buffer.from(`${secret}:`, 'utf8').toString('base64')}`;
}

const json = (secret: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  ...extra,
});

// ---------------------------------------------------------------------------
// Stripe Connect: direct charges on the connected account (platform key + Stripe-Account).
// ---------------------------------------------------------------------------

const STRIPE_ID = /^(pi|cs)_[A-Za-z0-9_]{1,250}$/;

/**
 * One Stripe call on the connected account.
 *
 * @param call Account and platform key.
 * @param method HTTP method.
 * @param path API path.
 * @param options Form body, query and idempotency key.
 * @returns The parsed answer.
 */
export function stripeRequest<T>(
  call: GatewayCall,
  method: 'GET' | 'POST',
  path: string,
  options: { form?: StripeForm; query?: string; idempotencyKey?: string } = {},
): Promise<T> {
  return call.http<T>(`${STRIPE_API}${path}${options.query ? `?${options.query}` : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${call.secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(call.stripePlatformMode === true ? {} : { 'Stripe-Account': call.externalAccountId }),
      ...(options.idempotencyKey === undefined ? {} : { 'Idempotency-Key': options.idempotencyKey }),
    },
    ...(options.form === undefined ? {} : { body: toStripeForm(options.form) }),
  });
}

function stripeLookup(intent: StripePaymentIntent, sessionCustomer: string | null): GatewayLookup {
  return {
    transactionId: intent.id,
    transaction: stripeIntentToTransaction(intent),
    savedCard: stripeSavedCard(intent, sessionCustomer),
  };
}

const stripeAdapter: GatewayAdapter = {
  auth: 'oauth',
  supportsAutopay: true,
  async createCheckout(call, input) {
    const session = await stripeRequest<{ id: string; url: string }>(call, 'POST', '/v1/checkout/sessions', {
      idempotencyKey: input.idempotencyKey,
      form: {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'mxn',
              unit_amount: toCents(input.amount),
              product_data: { name: input.title },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.orderReference,
        metadata: { [STRIPE_ORDER_METADATA_KEY]: input.orderReference },
        payment_intent_data: {
          metadata: { [STRIPE_ORDER_METADATA_KEY]: input.orderReference },
          setup_future_usage: input.saveCard ? 'off_session' : undefined,
        },
        customer_creation: input.saveCard ? 'always' : undefined,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      },
    });
    return { sessionId: session.id, url: session.url };
  },
  async lookup(call, ref) {
    if (ref.transactionId !== null) {
      const intent = await stripeRequest<StripePaymentIntent>(
        call,
        'GET',
        `/v1/payment_intents/${pathId(ref.transactionId, STRIPE_ID)}`,
        { query: 'expand[]=payment_method' },
      );
      return stripeLookup(intent, null);
    }
    if (ref.sessionId === null) {
      return null;
    }
    const session = await stripeRequest<{
      customer?: string | null;
      payment_intent?: StripePaymentIntent | string | null;
    }>(call, 'GET', `/v1/checkout/sessions/${pathId(ref.sessionId, STRIPE_ID)}`, {
      query: 'expand[]=payment_intent&expand[]=payment_intent.payment_method',
    });
    const intent = session.payment_intent;
    return typeof intent === 'object' && intent !== null
      ? stripeLookup(intent, session.customer ?? null)
      : null;
  },
  async refund(call, transactionId, amount, idempotencyKey) {
    await stripeRequest(call, 'POST', '/v1/refunds', {
      idempotencyKey,
      form: { payment_intent: pathId(transactionId, STRIPE_ID), amount: toCents(amount) },
    });
  },
};

// ---------------------------------------------------------------------------
// Mercado Pago Checkout Pro, with the seller's OAuth token.
// ---------------------------------------------------------------------------

const MP_ID = /^\d{1,20}$/;

const mercadoPagoAdapter: GatewayAdapter = {
  auth: 'oauth',
  supportsAutopay: false,
  async createCheckout(call, input) {
    const preference = await call.http<{ id: string; init_point: string; sandbox_init_point?: string }>(
      `${MP_API}/checkout/preferences`,
      {
        method: 'POST',
        headers: json(call.secret, { 'X-Idempotency-Key': input.idempotencyKey }),
        body: JSON.stringify({
          items: [{ title: input.title, quantity: 1, unit_price: Number(input.amount), currency_id: 'MXN' }],
          external_reference: input.orderReference,
          back_urls: { success: input.successUrl, failure: input.cancelUrl, pending: input.successUrl },
          auto_return: 'approved',
          ...(input.notificationUrl === null ? {} : { notification_url: input.notificationUrl }),
          expires: true,
          expiration_date_from: new Date().toISOString(),
          expiration_date_to: input.expiresAt.toISOString(),
        }),
      },
    );
    const url =
      call.environment === 'LIVE'
        ? preference.init_point
        : (preference.sandbox_init_point ?? preference.init_point);
    return { sessionId: preference.id, url };
  },
  async lookup(call, ref) {
    const map = (payment: MercadoPagoPayment): GatewayLookup => ({
      transactionId: String(payment.id),
      transaction: mercadoPagoPaymentToTransaction(payment),
      savedCard: null,
    });
    const headers = json(call.secret);
    if (ref.transactionId !== null) {
      return map(
        await call.http<MercadoPagoPayment>(`${MP_API}/v1/payments/${pathId(ref.transactionId, MP_ID)}`, {
          method: 'GET',
          headers,
        }),
      );
    }
    const query = new URLSearchParams({
      external_reference: ref.orderReference,
      sort: 'date_created',
      criteria: 'desc',
    });
    const search = await call.http<{ results?: MercadoPagoPayment[] }>(
      `${MP_API}/v1/payments/search?${query.toString()}`,
      { method: 'GET', headers },
    );
    const results = search.results ?? [];
    // An approved payment wins over the rejected attempts before it.
    const payment = results.find((p) => p.status === 'approved') ?? results[0];
    return payment === undefined ? null : map(payment);
  },
  async refund(call, transactionId, amount, idempotencyKey) {
    await call.http(`${MP_API}/v1/payments/${pathId(transactionId, MP_ID)}/refunds`, {
      method: 'POST',
      headers: json(call.secret, { 'X-Idempotency-Key': idempotencyKey }),
      body: JSON.stringify({ amount: Number(amount) }),
    });
  },
};

// ---------------------------------------------------------------------------
// Conekta API v2.1: HostedPayment order. The Conekta order is both the hosted
// checkout and the transaction (refunds are per order).
// ---------------------------------------------------------------------------

const CONEKTA_ID = /^ord_[A-Za-z0-9]{1,64}$/;

const conektaHeaders = (secret: string): Record<string, string> => ({
  Authorization: basic(secret),
  Accept: CONEKTA_ACCEPT,
  'Accept-Language': 'es',
  'Content-Type': 'application/json',
});

/** Generic buyer for a Conekta order created without one; Conekta requires `customer_info`. */
const GENERIC_BUYER = { name: 'Cliente', email: 'cliente@example.com', phone: '5555555555' };

const conektaAdapter: KeysGatewayAdapter = {
  auth: 'keys',
  supportsAutopay: false,
  async createCheckout(call, input) {
    const buyer = input.buyer ?? GENERIC_BUYER;
    const order = await call.http<ConektaOrder>(`${CONEKTA_API}/orders`, {
      method: 'POST',
      headers: conektaHeaders(call.secret),
      body: JSON.stringify({
        currency: 'MXN',
        line_items: [{ name: input.title, unit_price: toCents(input.amount), quantity: 1 }],
        customer_info: { name: buyer.name, email: buyer.email, phone: buyer.phone ?? GENERIC_BUYER.phone },
        metadata: { [STRIPE_ORDER_METADATA_KEY]: input.orderReference },
        checkout: {
          type: 'HostedPayment',
          allowed_payment_methods: ['card', 'cash', 'bank_transfer'],
          success_url: input.successUrl,
          failure_url: input.cancelUrl,
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        },
      }),
    });
    if (typeof order.checkout?.url !== 'string') {
      throw new ValidationException('Conekta created the order without a checkout URL.');
    }
    return { sessionId: order.id, url: order.checkout.url };
  },
  async lookup(call, ref) {
    const id = ref.transactionId ?? ref.sessionId;
    if (id === null) {
      return null;
    }
    const order = await call.http<ConektaOrder>(`${CONEKTA_API}/orders/${pathId(id, CONEKTA_ID)}`, {
      method: 'GET',
      headers: conektaHeaders(call.secret),
    });
    if (order.payment_status === 'pending_payment' && (order.charges?.data?.length ?? 0) === 0) {
      return null;
    }
    return { transactionId: order.id, transaction: conektaOrderToTransaction(order), savedCard: null };
  },
  async refund(call, transactionId, amount) {
    await call.http(`${CONEKTA_API}/orders/${pathId(transactionId, CONEKTA_ID)}/refunds`, {
      method: 'POST',
      headers: conektaHeaders(call.secret),
      body: JSON.stringify({ amount: toCents(amount), reason: 'requested_by_client' }),
    });
  },
  async validateKeys(http, keys) {
    if (!/^key_[A-Za-z0-9]+$/.test(keys.privateKey) || !/^key_[A-Za-z0-9]+$/.test(keys.publicKey)) {
      throw new ValidationException('Conekta keys look like key_….');
    }
    const page = await http<{ data?: readonly { livemode?: boolean }[] }>(`${CONEKTA_API}/orders?limit=1`, {
      method: 'GET',
      headers: conektaHeaders(keys.privateKey),
    });
    // shortcut: Conekta keys carry no environment prefix; an account with no order yet reads as
    // SANDBOX until its first order says otherwise. Ask the API for the key's mode if Conekta adds one.
    return {
      externalAccountId: keys.publicKey,
      environment: page.data?.[0]?.livemode === true ? 'LIVE' : 'SANDBOX',
      publicKey: keys.publicKey,
    };
  },
  async registerWebhook(call, url) {
    const hook = await call.http<{ id: string }>(`${CONEKTA_API}/webhooks`, {
      method: 'POST',
      headers: conektaHeaders(call.secret),
      body: JSON.stringify({ url }),
    });
    return hook.id;
  },
  async deleteWebhook(call, webhookId) {
    await call.http(`${CONEKTA_API}/webhooks/${encodeURIComponent(webhookId)}`, {
      method: 'DELETE',
      headers: conektaHeaders(call.secret),
    });
  },
};

// ---------------------------------------------------------------------------
// Openpay: a card charge created with confirm=false redirects the buyer to
// Openpay's hosted page (`payment_method.url`).
// ---------------------------------------------------------------------------

const OPENPAY_ID = /^[a-z0-9]{1,40}$/i;

const openpayBase = (call: { externalAccountId: string; environment: 'SANDBOX' | 'LIVE' }): string =>
  `${OPENPAY_API[call.environment]}/v1/${pathId(call.externalAccountId, OPENPAY_ID)}`;

const openpayHeaders = (secret: string): Record<string, string> => ({
  Authorization: basic(secret),
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

const openpayAdapter: KeysGatewayAdapter = {
  auth: 'keys',
  supportsAutopay: false,
  async createCheckout(call, input) {
    const buyer = input.buyer ?? GENERIC_BUYER;
    const charge = await call.http<OpenpayCharge>(`${openpayBase(call)}/charges`, {
      method: 'POST',
      headers: openpayHeaders(call.secret),
      body: JSON.stringify({
        method: 'card',
        amount: Number(input.amount),
        currency: 'MXN',
        description: input.title,
        order_id: input.orderReference,
        confirm: 'false',
        send_email: false,
        redirect_url: input.successUrl,
        customer: { name: buyer.name, email: buyer.email, phone_number: buyer.phone ?? GENERIC_BUYER.phone },
      }),
    });
    if (typeof charge.payment_method?.url !== 'string') {
      throw new ValidationException('Openpay created the charge without a payment URL.');
    }
    return { sessionId: charge.id, url: charge.payment_method.url };
  },
  async lookup(call, ref) {
    const id = ref.transactionId ?? ref.sessionId;
    if (id === null) {
      return null;
    }
    const charge = await call.http<OpenpayCharge>(`${openpayBase(call)}/charges/${pathId(id, OPENPAY_ID)}`, {
      method: 'GET',
      headers: openpayHeaders(call.secret),
    });
    // Waiting on the hosted page: the buyer has not attempted anything yet.
    if (charge.status === 'charge_pending') {
      return null;
    }
    return { transactionId: charge.id, transaction: openpayChargeToTransaction(charge), savedCard: null };
  },
  async refund(call, transactionId, amount) {
    await call.http(`${openpayBase(call)}/charges/${pathId(transactionId, OPENPAY_ID)}/refund`, {
      method: 'POST',
      headers: openpayHeaders(call.secret),
      body: JSON.stringify({ amount: Number(amount), description: 'Refund' }),
    });
  },
  async validateKeys(http, keys) {
    if (
      keys.merchantId === undefined ||
      !/^m[a-z0-9]{10,39}$/i.test(keys.merchantId) ||
      !/^sk_[A-Za-z0-9]+$/.test(keys.privateKey) ||
      !/^pk_[A-Za-z0-9]+$/.test(keys.publicKey)
    ) {
      throw new ValidationException('Openpay needs merchantId (m…), privateKey (sk_…) and publicKey (pk_…).');
    }
    const environment = keys.environment === 'LIVE' ? 'LIVE' : 'SANDBOX';
    await http(openpayBase({ externalAccountId: keys.merchantId, environment }), {
      method: 'GET',
      headers: openpayHeaders(keys.privateKey),
    });
    return { externalAccountId: keys.merchantId, environment, publicKey: keys.publicKey };
  },
  async registerWebhook(call, url) {
    const hook = await call.http<{ id: string }>(`${openpayBase(call)}/webhooks`, {
      method: 'POST',
      headers: openpayHeaders(call.secret),
      body: JSON.stringify({
        url,
        event_types: ['charge.succeeded', 'charge.failed', 'charge.cancelled', 'charge.refunded'],
      }),
    });
    return hook.id;
  },
  async deleteWebhook(call, webhookId) {
    await call.http(`${openpayBase(call)}/webhooks/${pathId(webhookId, OPENPAY_ID)}`, {
      method: 'DELETE',
      headers: openpayHeaders(call.secret),
    });
  },
};

/** The adapter of every alternative gateway. */
export const GATEWAY_ADAPTERS: Readonly<Record<GatewayProvider, GatewayAdapter>> = {
  STRIPE: stripeAdapter,
  MERCADOPAGO: mercadoPagoAdapter,
  CONEKTA: conektaAdapter,
  OPENPAY: openpayAdapter,
};

/** The keys gateways' adapters (D8). */
export const KEYS_ADAPTERS: Readonly<Record<KeysGatewayProvider, KeysGatewayAdapter>> = {
  CONEKTA: conektaAdapter,
  OPENPAY: openpayAdapter,
};
