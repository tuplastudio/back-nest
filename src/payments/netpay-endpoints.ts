import { testOnlyOverride } from '../config/test-overrides';
import type { DeclineCode } from './decline-codes';

/**
 * Netpay endpoints, checked against the v1.2.1 documentation and the Sandbox gateway.
 *
 * - `POST /v3.5/charges/` is the **Custom** charge. It answers
 *   `"CardTokenAndApiKeyOrStoreId not found with token : 'null'"` when `source`
 *   is missing, which is why a tokenized card is mandatory.
 * - `POST /v3.2/checkout/session/` is the **Hosted** session. The documentation
 *   publishes its body: `paymentMethodTypes` is the only required field, and
 *   omitting `billing` makes Netpay collect it on its own page.
 * - `POST /checkout` does **not** exist and answers "No message available".
 */

/** Base URL per environment. */
export const NETPAY_HOSTS = {
  SANDBOX: 'https://gateway-154.netpaydev.com/gateway-ecommerce',
  LIVE: 'https://suite.netpay.com.mx/gateway-ecommerce',
} as const;

/**
 * Base URL of the reports service, which is where refunds live.
 *
 * Unlike every other call, a refund goes to a different host and authenticates
 * with `X-Netpay-Apikey`. Both URLs are published in "Cancelar o reembolsar una
 * transacción".
 */
export const NETPAY_REPORTS_HOSTS = {
  SANDBOX: 'https://gateway.netpay-api.com/reports-sandbox',
  LIVE: 'https://out.netpay-api.com/reports',
} as const;

/** Netpay environment names. */
export type NetpayEnvironment = keyof typeof NETPAY_HOSTS;

/** Verified API paths. */
export const NETPAY_PATHS = {
  /** Custom charge against a tokenized card. Requires `source`. */
  CHARGE: '/v3.5/charges/',
  /** Authoritative status of a transaction. */
  TRANSACTION: '/v3/transactions/',
  /** Checkout Hosted session. Answers with the URL the buyer is sent to. */
  CHECKOUT_SESSION: '/v3.2/checkout/session/',
  /** Resolves the id a refund needs from the `transactionTokenId` a charge returns. */
  TRANSACTION_ID: '/v3/get/',
  /** Webhook URL registration, per key set. */
  WEBHOOKS: '/v3/webhooks/',
  /** Customer profiles: read, attach a card (`PUT …/token`), delete a card (`DELETE …/token/{card}`). */
  CLIENT: '/v3/clients/',
  /** Amount token. Binds the figure server-side so the buyer cannot alter it. */
  TOKEN_AMOUNT: '/v3/token/amount',
  /**
   * Customer profile, for storing cards.
   *
   * Note the version and the noun: the stored-card flow lives on `v4` under
   * `clients`. `/v3/customers` and `/v2/customers` do not exist and answer
   * "No message available".
   */
  CLIENTS: '/v4/clients',
  /**
   * Cancels a charge: `POST /v3/transactions/{transactionTokenId}/refund` on the
   * gateway, authenticated with the secret key. It takes no body, so it reverses the
   * WHOLE charge, and Netpay only honours it before 21:30 (Mexico City) on the day of
   * the charge. Verified against the sandbox on 2026-10-14: the transaction goes
   * `DONE` -> `CANCELED`.
   */
  TRANSACTION_CANCEL: '/v3/transactions/',
  /** Cash reference for OXXO Pay. The product must be enabled on the account. */
  OXXO_REFERENCE: '/v3/oxxopay/reference',
} as const;

/**
 * Picks the base URL for an environment.
 *
 * `NETPAY_SANDBOX_BASE_URL` redirects the sandbox to a local stand-in so the
 * end-to-end suite can run the whole provider flow without credentials. It is
 * honoured only when `NODE_ENV` is `test` and only for the sandbox, so no
 * deployed process, and never the live account, can be pointed elsewhere by a
 * stray variable.
 *
 * @param environment Sandbox or Live.
 * @returns Base URL without a trailing slash.
 */
function baseUrlFor(environment: NetpayEnvironment): string {
  return overridable(environment, 'NETPAY_SANDBOX_BASE_URL', NETPAY_HOSTS[environment]);
}

/**
 * Applies the test-only sandbox override to a base URL.
 *
 * @param environment Sandbox or Live.
 * @param variable Name of the override variable.
 * @param fallback The published URL.
 * @returns The override when allowed, otherwise the published URL.
 */
function overridable(environment: NetpayEnvironment, variable: string, fallback: string): string {
  const override = testOnlyOverride(variable);
  if (environment === 'SANDBOX' && override) {
    return override.replace(/\/+$/, '');
  }
  return fallback;
}

/**
 * Builds a fully-qualified URL on the reports service.
 *
 * @param environment Sandbox or Live.
 * @param path Path beginning with a slash.
 * @returns Absolute URL.
 */
export function netpayReportsUrl(environment: NetpayEnvironment, path: string): string {
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) {
    throw new Error(`Refusing to build a Netpay reports URL from an unsafe path: ${path}`);
  }
  return `${overridable(environment, 'NETPAY_SANDBOX_REPORTS_BASE_URL', NETPAY_REPORTS_HOSTS[environment])}${path}`;
}

/**
 * Builds a fully-qualified Netpay URL.
 *
 * @param environment Sandbox or Live.
 * @param path Path from {@link NETPAY_PATHS}.
 * @returns Absolute URL.
 */
export function netpayUrl(environment: NetpayEnvironment, path: string): string {
  const base = baseUrlFor(environment);
  if (!base) {
    throw new Error(`Unknown Netpay environment: ${String(environment)}`);
  }
  if (!path.startsWith('/')) {
    throw new Error(`Netpay path must start with a slash: ${path}`);
  }
  if (path.includes('..') || path.includes('//')) {
    // Defensive: the callers build paths from a validated id and these
    // constants, but an escape would send credentials somewhere unintended.
    throw new Error(`Refusing to build a Netpay URL from an unsafe path: ${path}`);
  }
  return `${base}${path}`;
}

/**
 * A transaction status Netpay reports.
 *
 * The first eight are the statuses the documentation lists for a charge
 * ("Estatus devueltos al consultar detalle"). `IN_PROCESS` is what a payment
 * reference (`cep.*` notification) reports while it waits for the buyer.
 */
export type NetpayTransactionStatus =
  | 'DONE'
  | 'CANCELED'
  | 'FAILED'
  | 'INSECURE'
  | 'REJECT'
  | 'REVIEW'
  | 'WAIT_THREEDS'
  | 'CHARGEABLE'
  | 'IN_PROCESS';

/** Provider statuses that mean the money moved. */
export const SETTLED_STATUSES: readonly NetpayTransactionStatus[] = ['DONE'];

/**
 * Provider statuses that mean the charge definitively did not happen.
 *
 * `REJECT` is the issuer's refusal, `FAILED` covers a declined card or a failed
 * 3DS authentication, `INSECURE` is a transaction flagged for review that was not
 * released, and `CANCELED` is a charge reversed after it was `DONE`.
 */
export const FAILED_STATUSES: readonly NetpayTransactionStatus[] = [
  'FAILED',
  'REJECT',
  'INSECURE',
  'CANCELED',
];

/**
 * Provider statuses that mean "not decided yet".
 *
 * `WAIT_THREEDS` is the one a merchant has to act on: the buyer authenticated and
 * the charge must be confirmed, once, before it reaches the bank.
 */
export const PENDING_STATUSES: readonly NetpayTransactionStatus[] = [
  'REVIEW',
  'WAIT_THREEDS',
  'CHARGEABLE',
  'IN_PROCESS',
];

/**
 * The 3-D Secure block of a charge answered with `review`.
 *
 * Netpay returns it for both outcomes of 3DS 2.0. Frictionless arrives with
 * `responseCode` 100 and no `acsUrl`: `netpay3ds.canProceed` is false and the
 * storefront confirms with a null processor id. A challenge arrives with
 * `responseCode` 475 and an `acsUrl` the buyer is taken to.
 */
export interface NetpayThreeDSecure {
  /** `PROCEED_TO_VALIDATE_AUTHENTICATION` when a challenge is required. */
  status?: string;
  responseCode?: string | number;
  acsUrl?: string | null;
  paReq?: string | null;
  authenticationTransactionID?: string;
}

/** Shape of `GET /v3/transactions/{id}`. */
export interface NetpayTransaction {
  transactionTokenId?: string;
  threeDSecureResponse?: NetpayThreeDSecure;
  status?: string;
  merchantReferenceCode?: string | null;
  amount?: number | string;
  currency?: string | null;
  responseCode?: string | null;
  responseMsg?: string | null;
  /**
   * Netpay's reason for a declined charge (e.g. "Rejected by Decision Manager"),
   * shortened and stripped of control characters. Set by the client, never sent.
   */
  declineReason?: string | null;
  /** Stable decline code (BN-REQ-PAY-006). Set by the client, never sent. */
  failureCode?: DeclineCode;
  /** Netpay's own decline code, kept internally for diagnosis. Set by the client. */
  providerFailureCode?: string | null;
}

/** One line of a Checkout Hosted session. Amounts travel as strings. */
export interface NetpaySessionLineItem {
  readonly name: string;
  readonly amount: string;
  readonly quantity: string;
  readonly currency: string;
}

/** Body of `POST /v3.2/checkout/session/`. */
export interface NetpaySessionBody {
  /** `card`, and/or `cep` (cash reference, which Netpay shows as OXXO). */
  readonly paymentMethodTypes: readonly ('card' | 'cep')[];
  readonly lineItems: readonly NetpaySessionLineItem[];
  readonly linkType: 'NETPAY_CHECKOUT';
  /** Unique per payment. The order reference is used, so a retry cannot clash. */
  readonly merchantRefCode: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
}

/** Body of `POST /v3/oxxopay/reference`. */
export interface NetpayOxxoReferenceBody {
  readonly amount: string;
  readonly currency: 'MXN';
  readonly name: string;
  readonly email: string;
  readonly phone?: string;
  readonly merchantReferenceCode?: string;
  readonly oxxoPay?: { readonly expirationNumber: string; readonly expirationType: 'DAY' | 'HOUR' };
}

/** What `POST /v3/oxxopay/reference` answers with. */
export interface NetpayOxxoReference {
  readonly amount?: number | string;
  readonly merchantReferenceCode?: string;
  /** Numeric reference the buyer pays at the store. */
  readonly reference: string;
  readonly referenceType?: string;
  readonly transactionId?: string;
  readonly oxxoPay?: {
    readonly expirationNumber?: number | string;
    readonly expirationType?: string;
    readonly expirationDate?: string;
  };
}

/** What the session endpoint answers with. */
export interface NetpaySession {
  readonly id?: number;
  readonly sessionId: string;
  readonly hostedCheckoutUrl: string;
  readonly merchantRefCode?: string;
  readonly paidOut?: boolean;
}

/** Billing details Netpay requires on a charge. */
export interface NetpayBilling {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly merchantReferenceCode: string;
  readonly phone?: string;
  /**
   * Billing address. The documentation lists it as optional, but the gateway
   * answers 500 to a charge without it, so it is required here.
   */
  readonly address?: NetpayAddress;
}

/** Postal address, with country and state as ISO 3166 alpha-2 codes. */
export interface NetpayAddress {
  readonly city: string;
  readonly country: string;
  readonly postalCode: string;
  readonly state: string;
  readonly street1: string;
  /** Neighbourhood (colonia). */
  readonly street2?: string;
}

/** Body of `POST /v3/charges/`, following the published OpenAPI definition. */
export interface NetpayChargeBody {
  readonly transactionType: 'Auth';
  readonly amount: number;
  readonly currency: string;
  readonly description: string;
  readonly paymentMethod: 'card';
  /** Token produced by client-side tokenisation. Mandatory on this endpoint. */
  readonly source: string;
  readonly sessionId: string;
  readonly deviceFingerPrint: string;
  readonly referenceID: string;
  /** Must be `false` when paying with a stored card. */
  readonly saveCard: 'true' | 'false';
  /**
   * Security code. Netpay requires it on every charge with a **stored** card and
   * the bank refuses the charge without it; a one-time token already carries it.
   */
  readonly cvv?: string;
  readonly billing: NetpayBilling;
  readonly client: { readonly id: string };
  readonly deviceInformation: Readonly<Record<string, string>>;
  /** Present only for installments; see {@link MSI_MINIMUM_BY_COUNT}. */
  readonly installments?: { readonly plan: { readonly count: number; readonly interval: 'month' } };
  /** Where Netpay returns the buyer after a 3DS challenge. */
  readonly redirect3dsUri?: string;
}

/**
/**
 * A stored card, as Netpay returns it inside a customer profile.
 *
 * Only the token and the last four digits ever come back; the card number and the
 * CVV never leave Netpay, which is what keeps them out of this system's PCI
 * scope.
 */
export interface NetpayStoredCard {
  readonly source: string;
  readonly type: string;
  readonly defaultCard?: number;
  /** Present when Netpay includes the card summary in the answer. */
  readonly card?: { readonly lastFourDigits?: string };
}

/**
 * Customer profile as returned by `POST /v4/clients`.
 */
export interface NetpayCustomerProfile {
  readonly id: string;
  readonly clientId?: number;
  readonly name?: string;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly identifier?: string;
  /** May contain `null` when the profile was created without a card. */
  readonly paymentSources?: (NetpayStoredCard | null)[];
}

/** Body of `POST /v4/clients`. */
export interface NetpayCreateCustomerBody {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  /** The merchant's own id for this buyer, matched against their system. */
  readonly identifier: string;
  /** Card to attach immediately; omit to create the profile without one. */
  readonly paymentSource?: { readonly type: 'card'; readonly source: string };
}

/**
 * Result of tokenising an amount.
 *
 * `tokenAmount` is what the browser hands to the Netpay button; it carries the
 * figure, so the checkout never trusts an amount coming from the client.
 */
export interface NetpayAmountToken {
  readonly tokenAmount: string;
  readonly amount: number;
  readonly clientId?: number;
  readonly storeId?: number;
}

/**
 * Minimum amount in MXN required for each installment count, as published.
 *
 * Netpay rejects an `installments` plan whose count is not offered for the
 * amount, so this is checked before the call rather than discovered through a
 * provider error the merchant has to decode.
 */
export const MSI_MINIMUM_BY_COUNT: Readonly<Record<number, number>> = {
  3: 300,
  6: 600,
  9: 900,
  12: 1200,
  18: 1800,
};

/** The longest plan, which Netpay offers on Visa and Mastercard only (AMEX stops at 12). */
const MSI_VISA_MASTERCARD_ONLY = 18;

/** Installment counts Netpay offers. */
export const MSI_ALLOWED_COUNTS: readonly number[] = [3, 6, 9, 12, 18];

/**
 * Checks an installment plan against the published minimums.
 *
 * @param count Requested number of installments.
 * @param amount Amount in MXN.
 * @param cardBrand Brand reported at tokenisation, when the caller knows it.
 * @returns `null` when the plan is acceptable, otherwise the reason.
 */
export function msiRejection(count: number, amount: string, cardBrand?: string): string | null {
  if (!MSI_ALLOWED_COUNTS.includes(count)) {
    return `Netpay offers ${MSI_ALLOWED_COUNTS.join(', ')} installments, not ${count}.`;
  }
  if (
    count === MSI_VISA_MASTERCARD_ONLY &&
    cardBrand !== undefined &&
    !/^(visa|master ?card)$/i.test(cardBrand)
  ) {
    return `A ${count}-installment plan is offered on Visa and Mastercard only, not ${cardBrand}.`;
  }
  const minimum = MSI_MINIMUM_BY_COUNT[count];
  if (Number(amount) < minimum) {
    return `A ${count}-installment plan needs at least ${minimum} MXN; this order is ${amount}.`;
  }
  return null;
}

/**
 * Normalises a Netpay status string.
 *
 * @param status Raw status from the API.
 * @returns The recognised status, or `null` when unknown.
 */
export function parseStatus(status: string | undefined | null): NetpayTransactionStatus | null {
  if (!status) {
    return null;
  }
  const upper = status.toUpperCase();
  const known: readonly string[] = [...SETTLED_STATUSES, ...FAILED_STATUSES, ...PENDING_STATUSES];
  return known.includes(upper) ? (upper as NetpayTransactionStatus) : null;
}

/**
 * Converts a Netpay amount into an exact decimal string.
 *
 * Going through a fixed two-decimal representation rather than the raw float,
 * because `19.99` is not representable in binary floating point and the
 * comparison against the order must not depend on that.
 *
 * @param amount Amount reported by Netpay.
 * @returns A two-decimal string, or `null` when unusable.
 */
export function toAmountString(amount: number | string | null | undefined): string | null {
  if (amount === null || amount === undefined) {
    return null;
  }
  const text = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  return Number(text).toFixed(2);
}

/** A card as Netpay returns it from the customer endpoints. */
export interface NetpayClientCard {
  readonly token?: string;
  readonly lastFourDigits?: string;
  readonly brand?: string;
  readonly bank?: string;
  readonly type?: string;
  readonly expMonth?: string;
  readonly expYear?: string;
}

/** One payment source of a customer, as `GET /v3/clients/{id}` reports it. */
interface NetpayPaymentSource {
  readonly cardDefault?: boolean;
  readonly source?: string;
  readonly type?: string;
  readonly card?: NetpayClientCard;
}

/** Shape of `GET /v3/clients/{id}`. */
export interface NetpayClientInfo {
  readonly id?: string;
  readonly identifier?: string;
  readonly paymentSources?: (NetpayPaymentSource | null)[];
}

/** Netpay lets a customer hold between one and three card tokens. */
export const MAX_CARDS_PER_CLIENT = 3;

/**
 * Field rules Netpay's certification checks ("Requisitos para una certificación
 * exitosa para integraciones e-commerce").
 *
 * - Numeric fields (phone, postal code) take digits only.
 * - Text fields (names, address, references) are filtered of `! # $ % & * < > ? /`,
 *   backslashes and control characters before they reach Netpay; see {@link netpayText}.
 * - `country` and `state` are the ISO 3166 segment only (`MX`, `NLE`); Netpay builds
 *   the full `MX-NLE` itself.
 */
export const NETPAY_DIGITS_PATTERN = /^[0-9]+$/;
export const NETPAY_COUNTRY_PATTERN = /^[A-Z]{2}$/;
export const NETPAY_STATE_PATTERN = /^[A-Z0-9]{2,3}$/;

/** Characters the certification asks to filter out of text fields. */
// eslint-disable-next-line no-control-regex
const NETPAY_FORBIDDEN_TEXT = /[!#$%&*<>?/\\\u0000-\u001f\u007f]/g;

/**
 * Filters a text field the way Netpay's certification asks.
 *
 * Filtered rather than refused: real addresses carry `#` and `S/N`, and a tenant's
 * own references may carry `/`, so rejecting them would break legitimate traffic.
 * Only the copy sent to Netpay is filtered; what the tenant stored is untouched.
 *
 * @param value Text as received.
 * @returns The text without the filtered characters, whitespace collapsed.
 */
export function netpayText(value: string): string {
  return (
    value
      // OXXO Pay answers 400 "Name is invalid" to "Díaz" or "Muñoz": diacritics are
      // stripped from everything sent to Netpay (á → a, ñ → n).
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(NETPAY_FORBIDDEN_TEXT, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Shape of a Netpay customer id, used for path parameters.
 *
 * Netpay's ids are base64-like and include `!` and `=` (e.g. `Pg=z8K!M7k0=T7=…`), so
 * the rule only excludes what could change the URL: separators, dots, query and
 * fragment marks, percent signs and whitespace.
 */
export const NETPAY_CLIENT_ID_PATTERN = /^[^/\\?#%.\s]{1,128}$/;

/** Shape of a Netpay card token. A card number never matches it. */
export const NETPAY_CARD_TOKEN_PATTERN = /^token_[A-Za-z0-9_-]{10,}$/;
