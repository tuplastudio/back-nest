import { Injectable, Logger } from '@nestjs/common';
import { UpstreamProviderException } from '../common/errors/app.exception';
import {
  FAILED_STATUSES,
  NETPAY_PATHS,
  parseStatus,
  netpayReportsUrl,
  netpayUrl,
  type NetpayAmountToken,
  type NetpaySession,
  type NetpaySessionBody,
  type NetpayCreateCustomerBody,
  type NetpayOxxoReference,
  type NetpayOxxoReferenceBody,
  type NetpayCustomerProfile,
  type NetpayChargeBody,
  type NetpayClientCard,
  type NetpayClientInfo,
  type NetpayEnvironment,
  type NetpayTransaction,
} from './netpay-endpoints';

/**
 * User-Agent sent on the requests Netpay documents as requiring one.
 *
 * Netpay validates the character set and rejects control characters, so this is a
 * fixed, inert value rather than anything reflected from a caller.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** What a transport must return. */
export interface HttpResponseLike {
  readonly status: number;
  readonly body: string;
}

/**
 * Minimal HTTP contract, with one method.
 *
 * Injected rather than constructed so the whole integration is testable without a
 * socket, which is the same discipline the rest of the codebase uses.
 */
export interface HttpTransport {
  request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  ): Promise<HttpResponseLike>;
}

/**
 * Raised when Netpay answers with a non-2xx status, or cannot be reached.
 *
 * A 502 rather than a generic 500: the request was well formed, the caller is
 * not at fault, and an order that never got a checkout session must not look
 * like a server bug to the client.
 */
export class NetpayRequestError extends UpstreamProviderException {
  constructor(
    /** Provider status, named apart from the HTTP status the base class carries. */
    readonly providerStatus: number,
    readonly path: string,
    /** What Netpay said, when it said something; it is what makes a refusal diagnosable. */
    readonly providerMessage: string | null = null,
  ) {
    super('Netpay', `The payment provider refused the request (status ${providerStatus}).`, {
      providerStatus,
      ...(providerMessage === null ? {} : { providerMessage }),
    });
  }
}

/** Raised when the transport itself fails (timeout, DNS, TLS). */
export class NetpayTransportError extends UpstreamProviderException {
  constructor(
    readonly path: string,
    // `cause` is declared on `Error`, so it overrides rather than adds.
    override readonly cause: unknown = undefined,
  ) {
    super('Netpay', 'The payment provider could not be reached.');
  }
}

/**
 * Talks to Netpay.
 *
 * Every method takes the tenant's own secret key and the environment from its
 * stored configuration, so a call can only ever be made against that tenant's
 * account.
 */
@Injectable()
export class NetpayClient {
  private readonly logger = new Logger(NetpayClient.name);

  constructor(private readonly transport: HttpTransport) {}

  /**
   * Tokenises an amount.
   *
   * This is the step that makes the hosted flow tamper-proof: the buyer is
   * handed a token rather than a figure, so the amount Netpay settles is the one
   * decided here. Netpay documents that no call may be made with zero, which
   * the caller enforces before reaching this point.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param amount Amount in MXN, with decimals.
   * @returns The token and the amount Netpay bound to it.
   */
  async tokenizeAmount(
    environment: NetpayEnvironment,
    secretKey: string,
    amount: number,
  ): Promise<NetpayAmountToken> {
    const path = NETPAY_PATHS.TOKEN_AMOUNT;
    const response = await this.send(environment, secretKey, path, 'POST', { amount });
    return this.parse<NetpayAmountToken>(response, path);
  }

  /**
   * Creates a customer profile, optionally attaching a card.
   *
   * Storing a card is what `saveCard` on a charge relies on: Netpay keeps the
   * card, this system keeps the returned token. Neither the card number nor the
   * CVV is ever seen here.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param body Profile details and the merchant's identifier for the buyer.
   * @returns The created profile.
   */
  async createClient(
    environment: NetpayEnvironment,
    secretKey: string,
    body: NetpayCreateCustomerBody,
  ): Promise<NetpayCustomerProfile> {
    const path = NETPAY_PATHS.CLIENTS;
    const response = await this.send(environment, secretKey, path, 'POST', body);
    return this.parse<NetpayCustomerProfile>(response, path);
  }

  /**
   * Charges a tokenized card. This is the Checkout Custom flow.
   *
   * `source` is mandatory on this endpoint: Netpay answers
   * "CardTokenAndApiKeyOrStoreId not found" without it. It is the token produced
   * by client-side tokenisation, never a card number.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param body Charge request body.
   * @param userAgent The buyer's browser `User-Agent`, which Netpay documents as the
   *   value to send; a fixed one is used when the caller has none.
   * @returns The transaction as Netpay reports it.
   */
  async createCharge(
    environment: NetpayEnvironment,
    secretKey: string,
    body: NetpayChargeBody,
    userAgent: string = USER_AGENT,
  ): Promise<NetpayTransaction> {
    const path = NETPAY_PATHS.CHARGE;
    const response = await this.send(
      environment,
      secretKey,
      path,
      'POST',
      body,
      // Netpay marks this header required on the charges endpoint.
      { 'User-Agent': isSafeUserAgent(userAgent) ? userAgent : USER_AGENT },
      'gateway',
      true,
    );
    if (response.status >= 400) {
      // A decline is a 409 that still carries the created transaction with
      // `status: "failed"` (verified against the sandbox). It is a charge outcome,
      // not a provider fault, so it is returned for the order to record. Any other
      // 4xx is a refusal of the request itself.
      let declined: NetpayTransaction | null = null;
      try {
        declined = JSON.parse(response.body) as NetpayTransaction;
      } catch {
        declined = null;
      }
      const outcome = parseStatus(declined?.status);
      if (
        response.status !== 409 ||
        declined === null ||
        typeof declined.transactionTokenId !== 'string' ||
        outcome === null ||
        !FAILED_STATUSES.includes(outcome)
      ) {
        this.logger.warn(`Netpay POST ${path} returned status ${response.status}`);
        throw new NetpayRequestError(response.status, path, providerMessageOf(response.body));
      }
      return { ...declined, declineReason: providerMessageOf(response.body) };
    }
    return this.parse<NetpayTransaction>(response, path);
  }

  /**
   * Reads a transaction.
   *
   * This is the authoritative answer about whether a payment moved. The webhook
   * only tells us to come and ask.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param transactionId Transaction to inspect.
   * @returns The transaction as Netpay reports it.
   */
  async getTransaction(
    environment: NetpayEnvironment,
    secretKey: string,
    transactionId: string,
  ): Promise<NetpayTransaction> {
    const path = `${NETPAY_PATHS.TRANSACTION}${encodeURIComponent(transactionId)}`;
    const response = await this.send(environment, secretKey, path, 'GET');
    return this.parse<NetpayTransaction>(response, path);
  }

  /**
   * Creates a Checkout Hosted session.
   *
   * The answer carries the URL the buyer is sent to. Netpay hosts the payment
   * page, so no card data ever reaches this system.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param body Session description.
   * @returns The session, including `hostedCheckoutUrl`.
   */
  async createCheckoutSession(
    environment: NetpayEnvironment,
    secretKey: string,
    body: NetpaySessionBody,
  ): Promise<NetpaySession> {
    const path = NETPAY_PATHS.CHECKOUT_SESSION;
    const response = await this.send(environment, secretKey, path, 'POST', body);
    const session = this.parse<NetpaySession>(response, path);
    if (typeof session.hostedCheckoutUrl !== 'string' || typeof session.sessionId !== 'string') {
      throw new NetpayTransportError(path, new Error('Netpay returned a session without a checkout URL.'));
    }
    return session;
  }

  /**
   * Creates an OXXO Pay cash reference.
   *
   * The buyer takes the reference to a store and pays in cash; Netpay then calls
   * the webhook with `oxxopay.paid`. Netpay must have the product enabled on the
   * account, otherwise it answers 400 "This payment method is inactive".
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param body Amount, buyer and expiration.
   * @returns The reference and its expiration date.
   */
  async createOxxoReference(
    environment: NetpayEnvironment,
    secretKey: string,
    body: NetpayOxxoReferenceBody,
  ): Promise<NetpayOxxoReference> {
    const path = NETPAY_PATHS.OXXO_REFERENCE;
    const reference = this.parse<NetpayOxxoReference>(
      await this.send(environment, secretKey, path, 'POST', body),
      path,
    );
    if (typeof reference.reference !== 'string' || reference.reference.trim() === '') {
      throw new NetpayTransportError(path, new Error('Netpay returned an empty OXXO reference.'));
    }
    return reference;
  }

  /**
   * Resolves the id a refund needs.
   *
   * A charge returns a `transactionTokenId`, but the refund service is keyed by a
   * different identifier, which this call translates.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param transactionTokenId Id returned by the charge.
   * @returns The id the refund service expects.
   */
  async getRefundableId(
    environment: NetpayEnvironment,
    secretKey: string,
    transactionTokenId: string,
  ): Promise<string> {
    const path = `${NETPAY_PATHS.TRANSACTION_ID}${encodeURIComponent(transactionTokenId)}/transactionId`;
    const response = await this.send(environment, secretKey, path, 'GET');
    const parsed = this.parse<{ transactionId?: string }>(response, path);
    if (typeof parsed.transactionId !== 'string' || parsed.transactionId === '') {
      throw new NetpayTransportError(path, new Error('Netpay returned no transaction id.'));
    }
    return parsed.transactionId;
  }

  /**
   * Cancels a whole charge through the gateway (`POST /v3/transactions/{id}/refund`).
   *
   * This is the call that works in the sandbox, where the reports service answers 500
   * "No es posible mostrar transacciones" to every refund. It has no body, so it can
   * only reverse the full amount, and Netpay accepts it only until 21:30 (Mexico City)
   * of the day of the charge; later it answers an error and the caller falls back to
   * {@link NetpayClient.refund}.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param transactionTokenId Id returned by the charge.
   * @returns The status Netpay reports after the call (`CANCELED` when it worked).
   */
  async cancelCharge(
    environment: NetpayEnvironment,
    secretKey: string,
    transactionTokenId: string,
  ): Promise<string | null> {
    const path = `${NETPAY_PATHS.TRANSACTION_CANCEL}${encodeURIComponent(transactionTokenId)}/refund`;
    const answer = this.parse<{ status?: string }>(
      await this.send(environment, secretKey, path, 'POST'),
      path,
    );
    return typeof answer.status === 'string' ? answer.status : null;
  }

  /**
   * Cancels or refunds a transaction.
   *
   * Two calls: the charge's `transactionTokenId` is first translated to the id the
   * refund service keys on, then the reversal goes to the reports service, which
   * authenticates with `X-Netpay-Apikey` rather than `Authorization`. Before 21:30
   * on the day of the charge Netpay treats it as a cancellation, after as a
   * refund; the request is the same.
   *
   * Netpay disables this operation by default per merchant and answers
   * "Comercio no tiene permitida esta operativa" until it is enabled.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param transactionTokenId Id returned by the charge.
   * @param amount Amount to refund, in the charge currency.
   * @param motive Reason recorded with the reversal.
   * @returns Nothing; a 2xx means the reversal was accepted.
   */
  async refund(
    environment: NetpayEnvironment,
    secretKey: string,
    transactionTokenId: string,
    amount: string,
    motive: string,
  ): Promise<void> {
    const refundableId = await this.getRefundableId(environment, secretKey, transactionTokenId);
    await this.send(
      environment,
      secretKey,
      `/v2/transactions/${encodeURIComponent(refundableId)}/refund`,
      'PUT',
      { amount, motive },
      {},
      'reports',
    );
  }

  /**
   * Confirms a charge after the buyer passed 3-D Secure.
   *
   * Only valid while the transaction is `WAIT_THREEDS`, and only once: Netpay
   * warns that repeating the call repeats the request to the bank.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param transactionTokenId Transaction to confirm.
   * @param processorTransactionId Id the 3DS library handed back. `null` when
   *   `netpay3ds.canProceed` said no challenge was needed: Netpay documents calling
   *   confirm with a null processor id in that case, which is sent as the literal
   *   `null` the reference library would produce.
   */
  async confirmCharge(
    environment: NetpayEnvironment,
    secretKey: string,
    transactionTokenId: string,
    processorTransactionId: string | null,
  ): Promise<void> {
    await this.send(
      environment,
      secretKey,
      `${NETPAY_PATHS.CHARGE}${encodeURIComponent(transactionTokenId)}/confirm?processorTransactionId=${encodeURIComponent(processorTransactionId ?? 'null')}`,
      'POST',
    );
  }

  /**
   * Reads a customer profile with its stored cards.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param clientId Netpay's id for the customer.
   * @returns The profile.
   */
  async getClient(
    environment: NetpayEnvironment,
    secretKey: string,
    clientId: string,
  ): Promise<NetpayClientInfo> {
    const path = `${NETPAY_PATHS.CLIENT}${encodeURIComponent(clientId)}`;
    return this.parse<NetpayClientInfo>(await this.send(environment, secretKey, path, 'GET'), path);
  }

  /**
   * Attaches a card token to a customer that already exists.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param clientId Netpay's id for the customer.
   * @param token Card token from client-side tokenisation.
   * @param cvv2 Security code, which Netpay requires on this call.
   * @param preAuth Whether Netpay should hold 10 MXN to validate the card.
   * @returns The stored card, without the number.
   */
  async assignCard(
    environment: NetpayEnvironment,
    secretKey: string,
    clientId: string,
    token: string,
    cvv2: string,
    preAuth: boolean,
  ): Promise<NetpayClientCard> {
    const path = `${NETPAY_PATHS.CLIENT}${encodeURIComponent(clientId)}/token`;
    const response = await this.send(environment, secretKey, path, 'PUT', {
      token,
      cvv2,
      preAuth: preAuth ? 'true' : 'false',
    });
    return this.parse<NetpayClientCard>(response, path);
  }

  /**
   * Deletes a stored card from a customer.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param clientId Netpay's id for the customer.
   * @param token Card token to remove.
   */
  async deleteCard(
    environment: NetpayEnvironment,
    secretKey: string,
    clientId: string,
    token: string,
  ): Promise<void> {
    await this.send(
      environment,
      secretKey,
      `${NETPAY_PATHS.CLIENT}${encodeURIComponent(clientId)}/token/${encodeURIComponent(token)}`,
      'DELETE',
    );
  }

  /**
   * Reads the webhook URL registered for a key set.
   *
   * Netpay documents no response schema, so the body is returned as received and
   * the caller reads it defensively.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @returns The raw answer.
   */
  async getWebhook(environment: NetpayEnvironment, secretKey: string): Promise<Record<string, unknown>> {
    const path = NETPAY_PATHS.WEBHOOKS;
    return this.parse<Record<string, unknown>>(await this.send(environment, secretKey, path, 'GET'), path);
  }

  /**
   * Registers the inbound webhook URL for a key set.
   *
   * Registration is per key set, which is what makes the per-tenant isolation
   * work: each tenant's account has its own webhook URL.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's `sk_netpay_…`.
   * @param webhookUrl Absolute, publicly reachable HTTPS URL.
   * @returns Nothing; a 2xx means registered.
   */
  async registerWebhook(
    environment: NetpayEnvironment,
    secretKey: string,
    webhookUrl: string,
  ): Promise<void> {
    await this.send(environment, secretKey, NETPAY_PATHS.WEBHOOKS, 'PUT', { webhook: webhookUrl });
  }

  /**
   * Performs one request.
   *
   * @param environment Sandbox or Live.
   * @param secretKey The tenant's secret key.
   * @param path Path from {@link NETPAY_PATHS}.
   * @param method HTTP method.
   * @param body Request body, if any.
   * @param extraHeaders Headers this endpoint requires.
   * @returns The raw response.
   */
  private async send(
    environment: NetpayEnvironment,
    secretKey: string,
    path: string,
    method: string,
    body?: object,
    extraHeaders: Record<string, string> = {},
    service: 'gateway' | 'reports' = 'gateway',
    /** Lets a 4xx answer through to the caller instead of raising. */
    passClientErrors = false,
  ): Promise<HttpResponseLike> {
    let response: HttpResponseLike;
    try {
      // Netpay authenticates with the secret key as a bare header value. The
      // gateway reads it from `Authorization`, the reports service from
      // `X-Netpay-Apikey`.
      const authHeader: Record<string, string> =
        service === 'reports' ? { 'X-Netpay-Apikey': secretKey } : { Authorization: secretKey };
      response = await this.transport.request(
        service === 'reports' ? netpayReportsUrl(environment, path) : netpayUrl(environment, path),
        {
          method,
          headers: {
            ...authHeader,
            'Content-Type': 'application/json',
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: 10_000,
        },
      );
    } catch (error) {
      // The transport error is logged by type only: a Node TLS message can embed
      // the host, and this path must never carry a secret.
      this.logger.error(`Netpay ${method} ${path} failed: ${errorName(error)}`);
      throw new NetpayTransportError(path, error);
    }
    if (passClientErrors && response.status >= 400 && response.status < 500) {
      return response;
    }
    if (response.status < 200 || response.status >= 300) {
      this.logger.warn(`Netpay ${method} ${path} returned status ${response.status}`);
      throw new NetpayRequestError(response.status, path, providerMessageOf(response.body));
    }
    return response;
  }

  /**
   * Parses a JSON response.
   *
   * @param response Raw response.
   * @param path Path, for the error message.
   * @returns The parsed body.
   */
  private parse<T>(response: HttpResponseLike, path: string): T {
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new NetpayTransportError(path, new Error('Netpay returned a non-JSON body.'));
    }
  }
}

/**
 * Reports whether a `User-Agent` is safe to forward.
 *
 * Netpay validates the character set and a header value must not carry control
 * characters, so anything but printable ASCII of a sane length is replaced by the
 * fixed value.
 *
 * @param value Candidate header value.
 * @returns `true` when it can be sent as is.
 */
function isSafeUserAgent(value: string): boolean {
  return /^[\x20-\x7e]{1,512}$/.test(value);
}

/**
 * Extracts the human-readable message from a Netpay error body.
 *
 * Netpay answers with `{ message }` or `{ error }`. The text is shortened and
 * control characters are dropped, because it is shown to a caller and written to
 * logs. Nothing else from the body is kept: some endpoints echo the request.
 *
 * @param body Raw response body.
 * @returns The message, or `null` when there is none.
 */
function providerMessageOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const text = [parsed['message'], parsed['error']].find((v) => typeof v === 'string' && v.trim() !== '');
    if (typeof text !== 'string') {
      return null;
    }
    // Netpay says which field failed in `subErrors` ("name: Name is invalid"); without
    // it "Argument not valid" cannot be diagnosed. Field and reason only: the value
    // sent may be personal data and is not kept.
    const sub = Array.isArray(parsed['subErrors'])
      ? (parsed['subErrors'] as Record<string, unknown>[])
          .map((e) =>
            typeof e?.['field'] === 'string'
              ? `${e['field']}${typeof e['value'] === 'string' ? `: ${e['value']}` : ''}`
              : '',
          )
          .filter((v) => v !== '')
          .slice(0, 3)
          .join('; ')
      : '';
    return (
      `${text}${sub === '' ? '' : ` (${sub})`}`
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 200)
    );
  } catch {
    return null;
  }
}

/**
 * Returns an error's class name without its message.
 *
 * @param error Caught value.
 * @returns A safe label for logs.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
