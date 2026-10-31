import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NetpayTransaction } from '../netpay-endpoints';

/**
 * Pure pieces of the Stripe and Mercado Pago integrations (docs 33): signatures,
 * the OAuth `state`, form encoding, and the mapping of a gateway payment onto the
 * Netpay transaction shape that `PaymentOrdersService.applyVerification` judges.
 *
 * Nothing here does I/O, which is what lets the security-relevant parts be tested
 * byte for byte.
 */

/** Every alternative gateway, in the order `GET /gateways` lists them. */
export const GATEWAY_PROVIDERS = ['STRIPE', 'MERCADOPAGO', 'CONEKTA', 'OPENPAY'] as const;

/** An alternative gateway (docs 33). */
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

/** Who holds an order's payment. */
export type PaymentProvider = 'NETPAY' | GatewayProvider;

/** Gateways a tenant connects through the platform's OAuth app. */
export type OAuthGatewayProvider = 'STRIPE' | 'MERCADOPAGO';

/** Gateways a tenant connects by pasting its own API keys (D8). */
export type KeysGatewayProvider = 'CONEKTA' | 'OPENPAY';

/** Metadata key that carries the order reference on a Stripe session / PaymentIntent. */
export const STRIPE_ORDER_METADATA_KEY = 'bn_order_reference';

/** How long a hosted gateway checkout stays payable (Stripe's maximum is 24 h). */
export const GATEWAY_CHECKOUT_TTL_MS = 23 * 3_600_000;

/** Stripe's tolerance for a webhook timestamp. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Lifetime of an OAuth `state`. */
export const OAUTH_STATE_TTL_MS = 15 * 60_000;

/**
 * Reads a gateway from a path parameter.
 *
 * @param raw `stripe`, `mercadopago`, `conekta` or `openpay`, any case.
 * @returns The provider, or `null` for anything else.
 */
export function parseGatewayParam(raw: string | undefined): GatewayProvider | null {
  const value = (raw ?? '').toUpperCase();
  return GATEWAY_PROVIDERS.find((provider) => provider === value) ?? null;
}

/**
 * Whether a gateway connects through OAuth (Stripe, Mercado Pago) rather than keys.
 *
 * @param provider Gateway.
 * @returns `true` for an OAuth gateway.
 */
export function isOAuthGateway(provider: GatewayProvider): provider is OAuthGatewayProvider {
  return provider === 'STRIPE' || provider === 'MERCADOPAGO';
}

/**
 * Converts a two-decimal amount to integer cents without floating-point drift.
 *
 * @param amount `"100.50"`.
 * @returns `10050`.
 */
export function toCents(amount: string): number {
  const [units, fraction = ''] = amount.trim().split('.');
  return Number(units) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

/**
 * Converts integer cents to a two-decimal amount.
 *
 * @param cents `10050`.
 * @returns `"100.50"`, or `null` when not an integer.
 */
export function fromCents(cents: unknown): string | null {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) {
    return null;
  }
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;
}

/** A value Stripe's form encoding accepts. */
export type StripeFormValue = string | number | boolean | null | undefined | StripeFormValue[] | StripeForm;

/** A nested object to encode the way Stripe expects. */
export interface StripeForm {
  readonly [key: string]: StripeFormValue;
}

/**
 * Encodes a nested object as Stripe's `application/x-www-form-urlencoded`
 * (`line_items[0][price_data][currency]=mxn`). `null` / `undefined` are skipped.
 *
 * @param form Object to encode.
 * @returns Encoded body.
 */
export function toStripeForm(form: StripeForm): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: StripeFormValue): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(prefix === '' ? key : `${prefix}[${key}]`, nested);
      }
      return;
    }
    params.append(prefix, String(value));
  };
  walk('', form);
  return params.toString();
}

/**
 * Compares two strings in constant time.
 *
 * @param a Left.
 * @param b Right.
 * @returns `true` when equal.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies a `Stripe-Signature` header over the raw request body.
 *
 * `t=<unix>,v1=<hex>[,v1=…]`; the signed payload is `${t}.${rawBody}` with
 * HMAC-SHA256 under the endpoint secret. A timestamp outside the tolerance is
 * refused, so a captured delivery cannot be replayed later.
 *
 * @param rawBody Body exactly as received.
 * @param header `Stripe-Signature`.
 * @param secret `whsec_…`.
 * @param nowMs Current time.
 * @param toleranceSeconds Accepted clock distance.
 * @returns `true` when one `v1` matches and the timestamp is fresh.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  nowMs: number,
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (typeof header !== 'string' || header === '') {
    return false;
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 't' && /^\d+$/.test(value ?? '')) {
      timestamp = Number(value);
    } else if (key === 'v1' && value !== undefined) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) {
    return false;
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return signatures.some((candidate) => safeEqual(candidate, expected));
}

/**
 * Verifies Mercado Pago's `x-signature` (`ts=…,v1=…`).
 *
 * The manifest is `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, each part
 * left out when its value is absent (Mercado Pago's rule); an alphanumeric
 * `data.id` is lower-cased.
 *
 * @param input Header values and the notification's `data.id`.
 * @returns `true` when `v1` matches.
 */
export function verifyMercadoPagoSignature(input: {
  readonly signature: string | undefined;
  readonly requestId: string | undefined;
  readonly dataId: string | undefined;
  readonly secret: string;
}): boolean {
  if (typeof input.signature !== 'string' || input.signature === '') {
    return false;
  }
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of input.signature.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 'ts') {
      ts = value;
    } else if (key === 'v1') {
      v1 = value;
    }
  }
  if (ts === undefined || ts === '' || v1 === undefined || v1 === '') {
    return false;
  }
  const dataId = input.dataId === undefined || input.dataId === '' ? undefined : input.dataId.toLowerCase();
  const manifest =
    (dataId === undefined ? '' : `id:${dataId};`) +
    (input.requestId === undefined || input.requestId === '' ? '' : `request-id:${input.requestId};`) +
    `ts:${ts};`;
  const expected = createHmac('sha256', input.secret).update(manifest, 'utf8').digest('hex');
  return safeEqual(v1, expected);
}

/** What the OAuth `state` carries. */
export interface OAuthState {
  /** Tenant id. */
  readonly t: string;
  readonly p: OAuthGatewayProvider;
  /** Where to send the merchant back. */
  readonly r: string;
  /** Nonce. */
  readonly n: string;
  /** Expiry, epoch ms. */
  readonly e: number;
}

/**
 * Signs an OAuth `state`: `base64url(json).base64url(hmac)`.
 *
 * The callback is public and the state is the only thing that ties it to a
 * tenant, so it is signed rather than looked up.
 *
 * @param secret Signing key.
 * @param input Tenant, provider and return URL.
 * @param nowMs Current time.
 * @returns The token.
 */
export function signOAuthState(
  secret: Buffer | string,
  input: { tenantId: string; provider: OAuthGatewayProvider; returnUrl: string },
  nowMs: number,
): string {
  const state: OAuthState = {
    t: input.tenantId,
    p: input.provider,
    r: input.returnUrl,
    n: randomBytes(12).toString('base64url'),
    e: nowMs + OAUTH_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * Verifies an OAuth `state`.
 *
 * @param secret Signing key.
 * @param token As received on the callback.
 * @param nowMs Current time.
 * @returns The state, or `null` when forged, malformed or expired.
 */
export function verifyOAuthState(
  secret: Buffer | string,
  token: string | undefined,
  nowMs: number,
): OAuthState | null {
  if (typeof token !== 'string') {
    return null;
  }
  const [body, mac, extra] = token.split('.');
  if (body === undefined || mac === undefined || extra !== undefined) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) {
    return null;
  }
  try {
    const state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OAuthState>;
    if (
      typeof state.t !== 'string' ||
      (state.p !== 'STRIPE' && state.p !== 'MERCADOPAGO') ||
      typeof state.r !== 'string' ||
      typeof state.e !== 'number' ||
      state.e < nowMs
    ) {
      return null;
    }
    return state as OAuthState;
  } catch {
    return null;
  }
}

/**
 * Whether a return URL is on one of the allowed origins. An empty list allows nothing.
 *
 * @param url URL as sent.
 * @param origins `PAYMENT_GATEWAY_RETURN_ORIGINS`.
 * @returns `true` when its origin is listed.
 */
export function isAllowedReturnUrl(url: string, origins: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && origins.includes(parsed.origin);
  } catch {
    return false;
  }
}

/**
 * Appends query parameters to a URL.
 *
 * @param url Base URL.
 * @param params Parameters to set.
 * @returns The URL.
 */
export function withQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

/** The parts of a Stripe PaymentIntent this system reads. */
export interface StripePaymentIntent {
  readonly id: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly metadata?: Record<string, string>;
  readonly customer?: string | { readonly id: string } | null;
  readonly setup_future_usage?: string | null;
  readonly payment_method?:
    | string
    | { readonly id: string; readonly card?: { readonly brand?: string; readonly last4?: string } }
    | null;
  readonly last_payment_error?: {
    readonly code?: string;
    readonly decline_code?: string;
    readonly message?: string;
  } | null;
}

/** The parts of a Mercado Pago payment this system reads. */
export interface MercadoPagoPayment {
  readonly id: number | string;
  readonly status?: string;
  readonly status_detail?: string;
  readonly transaction_amount?: number;
  readonly currency_id?: string;
  readonly external_reference?: string | null;
  readonly date_created?: string;
}

/**
 * Maps a Stripe PaymentIntent onto the transaction shape verification judges.
 *
 * `succeeded` ⇒ `DONE`; `canceled`, or `requires_payment_method` after a failed
 * attempt ⇒ `FAILED`; anything else (processing, requires_action…) ⇒ `REVIEW`.
 * The order reference is what this system put in the metadata; the amount comes
 * from Stripe in cents.
 *
 * @param intent PaymentIntent as Stripe returned it.
 * @returns Netpay-shaped transaction.
 */
export function stripeIntentToTransaction(intent: StripePaymentIntent): NetpayTransaction {
  const failed =
    intent.status === 'canceled' ||
    (intent.status === 'requires_payment_method' && (intent.last_payment_error ?? null) !== null);
  return {
    transactionTokenId: intent.id,
    status: intent.status === 'succeeded' ? 'DONE' : failed ? 'FAILED' : 'REVIEW',
    merchantReferenceCode: intent.metadata?.[STRIPE_ORDER_METADATA_KEY] ?? null,
    amount: fromCents(intent.amount) ?? undefined,
    currency: intent.currency?.toUpperCase() ?? null,
    responseCode: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null,
    responseMsg: intent.last_payment_error?.message ?? null,
  };
}

/**
 * Maps a Mercado Pago payment onto the transaction shape verification judges.
 *
 * `approved` ⇒ `DONE`; `rejected` / `cancelled` ⇒ `FAILED`; anything else
 * (pending, in_process, authorized…) ⇒ `REVIEW`.
 *
 * @param payment Payment as Mercado Pago returned it.
 * @returns Netpay-shaped transaction.
 */
export function mercadoPagoPaymentToTransaction(payment: MercadoPagoPayment): NetpayTransaction {
  const status = payment.status ?? '';
  return {
    transactionTokenId: String(payment.id),
    status:
      status === 'approved' ? 'DONE' : status === 'rejected' || status === 'cancelled' ? 'FAILED' : 'REVIEW',
    merchantReferenceCode: payment.external_reference ?? null,
    amount:
      typeof payment.transaction_amount === 'number' ? payment.transaction_amount.toFixed(2) : undefined,
    currency: payment.currency_id ?? null,
    responseCode: payment.status_detail ?? null,
    responseMsg: payment.status_detail ?? null,
  };
}

/** A card a Stripe payment left saved for off-session charges. */
export interface GatewaySavedCard {
  readonly clientId: string;
  readonly cardToken: string;
  readonly brand: string | null;
  readonly last4: string | null;
}

/**
 * The saved card of a succeeded PaymentIntent created with
 * `setup_future_usage=off_session`, or `null`.
 *
 * @param intent PaymentIntent, with `payment_method` expanded for brand / last4.
 * @param sessionCustomer The Checkout Session's customer, when the intent has none.
 * @returns The card, or `null`.
 */
export function stripeSavedCard(
  intent: StripePaymentIntent,
  sessionCustomer: string | null = null,
): GatewaySavedCard | null {
  if (intent.status !== 'succeeded' || intent.setup_future_usage !== 'off_session') {
    return null;
  }
  const customer =
    typeof intent.customer === 'string' ? intent.customer : (intent.customer?.id ?? sessionCustomer);
  const method = intent.payment_method;
  const methodId = typeof method === 'string' ? method : (method?.id ?? null);
  if (customer === null || methodId === null) {
    return null;
  }
  const card = typeof method === 'object' && method !== null ? method.card : undefined;
  return { clientId: customer, cardToken: methodId, brand: card?.brand ?? null, last4: card?.last4 ?? null };
}

/** The parts of a Conekta order this system reads (API v2.1). */
export interface ConektaOrder {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly payment_status?: string | null;
  readonly metadata?: Record<string, string>;
  readonly checkout?: { readonly url?: string } | null;
  readonly charges?: {
    readonly data?: readonly {
      readonly id?: string;
      readonly status?: string;
      readonly failure_message?: string;
    }[];
  } | null;
}

/** The parts of an Openpay charge this system reads. */
export interface OpenpayCharge {
  readonly id: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly order_id?: string | null;
  readonly error_message?: string | null;
  readonly error_code?: number | string | null;
  readonly payment_method?: { readonly url?: string } | null;
}

/**
 * Maps a Conekta order onto the transaction shape verification judges (D9).
 *
 * `paid` ⇒ `DONE`; `declined` / `expired` / `canceled` ⇒ `FAILED`; anything else
 * (`pending_payment`…) ⇒ `REVIEW`. The amount is in cents; the order reference is
 * the metadata this system set.
 *
 * @param order Order as Conekta returned it.
 * @returns Netpay-shaped transaction.
 */
export function conektaOrderToTransaction(order: ConektaOrder): NetpayTransaction {
  const status = order.payment_status ?? '';
  const charge = order.charges?.data?.[0];
  return {
    transactionTokenId: order.id,
    status:
      status === 'paid'
        ? 'DONE'
        : status === 'declined' || status === 'expired' || status === 'canceled'
          ? 'FAILED'
          : 'REVIEW',
    merchantReferenceCode: order.metadata?.[STRIPE_ORDER_METADATA_KEY] ?? null,
    amount: fromCents(order.amount) ?? undefined,
    currency: order.currency?.toUpperCase() ?? null,
    responseCode: charge?.status ?? null,
    responseMsg: charge?.failure_message ?? null,
  };
}

/**
 * Maps an Openpay charge onto the transaction shape verification judges (D9).
 *
 * `completed` ⇒ `DONE`; `failed` / `cancelled` ⇒ `FAILED`; anything else
 * (`in_progress`, `charge_pending`) ⇒ `REVIEW`. `order_id` is the order reference.
 *
 * @param charge Charge as Openpay returned it.
 * @returns Netpay-shaped transaction.
 */
export function openpayChargeToTransaction(charge: OpenpayCharge): NetpayTransaction {
  const status = charge.status ?? '';
  return {
    transactionTokenId: charge.id,
    status:
      status === 'completed' ? 'DONE' : status === 'failed' || status === 'cancelled' ? 'FAILED' : 'REVIEW',
    merchantReferenceCode: charge.order_id ?? null,
    amount: typeof charge.amount === 'number' ? charge.amount.toFixed(2) : undefined,
    currency: charge.currency?.toUpperCase() ?? null,
    responseCode:
      charge.error_code === undefined || charge.error_code === null ? null : String(charge.error_code),
    responseMsg: charge.error_message ?? null,
  };
}
