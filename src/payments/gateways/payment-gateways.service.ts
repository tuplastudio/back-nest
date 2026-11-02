import { hkdfSync } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';
import { RequestContextService } from '../../tenancy/request-context.service';
import { AppConfig, type PaymentGatewaysConfig } from '../../config/app-config.service';
import { PaymentConfigService } from '../payment-config.service';
import { PaymentSecretBox } from '../payment-secret-box';
import {
  AppException,
  GatewayAccountInUseException,
  GatewayCredentialsInvalidException,
  GatewayNotConnectedException,
  NotFoundException,
  ProviderDeclinedException,
  ProviderOutcomeUnknownException,
  ReturnUrlNotAllowedException,
  UpstreamProviderException,
  ValidationException,
} from '../../common/errors/app.exception';
import {
  GATEWAY_CHECKOUT_TTL_MS,
  GATEWAY_PROVIDERS,
  STRIPE_ORDER_METADATA_KEY,
  isAllowedReturnUrl,
  isOAuthGateway,
  signOAuthState,
  toCents,
  toStripeForm,
  verifyOAuthState,
  withQuery,
  type GatewayProvider,
  type OAuthGatewayProvider,
  type StripePaymentIntent,
} from './gateway-endpoints';
import {
  GATEWAY_ADAPTERS,
  KEYS_ADAPTERS,
  MP_API,
  STRIPE_API,
  stripeRequest,
  type GatewayCall,
  type GatewayHttp,
  type GatewayKeys,
  type GatewayLookup,
} from './gateway-adapters';

export type { GatewayLookup } from './gateway-adapters';

const STRIPE_CONNECT = 'https://connect.stripe.com';
const MP_AUTHORIZE = 'https://auth.mercadopago.com.mx/authorization';

/** Per-call budget towards a gateway. */
const GATEWAY_TIMEOUT_MS = 15_000;

/** A Mercado Pago token this close to expiry is refreshed before use. */
const MP_REFRESH_BEFORE_MS = 7 * 86_400_000;

/** Where a gateway operation runs: a tenant schema, outside or inside a request. */
export interface GatewayScope {
  readonly schemaName: string;
  readonly tenantId: string;
}

/** One row of `GET /t/payments/gateways`. */
export interface GatewayStatusView {
  readonly provider: 'NETPAY' | GatewayProvider;
  /** `oauth`: a Connect button; `keys`: a form for the tenant's own keys. */
  readonly auth: 'oauth' | 'keys';
  readonly available: boolean;
  readonly connected: boolean;
  readonly environment: 'SANDBOX' | 'LIVE' | null;
  readonly accountId?: string | null;
  readonly connectedAt?: string | null;
  readonly supportsAutopay?: boolean;
}

type AccountRow = {
  provider: string;
  externalAccountId: string;
  environment: string;
  accessTokenCiphertext: string | null;
  refreshTokenCiphertext: string | null;
  tokenExpiresAt: Date | null;
  publicKey: string | null;
  webhookId: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
};

/**
 * A definitive 4xx from a gateway. Carries the parsed body for the caller to
 * inspect (a Stripe 402 names the declined PaymentIntent); the body is never
 * returned to the API client.
 */
export class GatewayRequestError extends ProviderDeclinedException {
  constructor(
    provider: string,
    readonly providerStatus: number,
    readonly body: unknown,
  ) {
    super(provider, `${provider} refused the request (${providerStatus}).`, { providerStatus });
  }
}

/** Mercado Pago's OAuth token answer. */
interface MercadoPagoToken {
  access_token: string;
  refresh_token?: string;
  user_id: number | string;
  public_key?: string;
  live_mode?: boolean;
  expires_in?: number;
}

/**
 * Alternative gateways (docs 33): connected accounts (OAuth for Stripe and
 * Mercado Pago, the tenant's own keys for Conekta and Openpay), and the calls an
 * order makes to its gateway.
 *
 * This service owns who the account is and how to authenticate; what to send is
 * the adapter's (`gateway-adapters.ts`). Like Netpay, a gateway never decides an
 * order on its own say-so: every lookup returns what the gateway's API answered,
 * mapped onto the transaction shape that `PaymentOrdersService.applyVerification`
 * judges (amount, order reference, one transaction ⇒ one order).
 */
@Injectable()
export class PaymentGatewaysService {
  private readonly logger = new Logger(PaymentGatewaysService.name);
  private readonly stateKey: Buffer;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly requestContext: RequestContextService,
    private readonly secretBox: PaymentSecretBox,
    private readonly paymentConfig: PaymentConfigService,
    private readonly app: AppConfig,
    config: ConfigService,
  ) {
    if (this.platform.stripePlatformModeRefused === true) {
      this.logger.warn(
        'Stripe is unavailable: STRIPE_CONNECT_CLIENT_ID is unset and the key is not a test key. Platform-account mode only accepts sk_test_ keys.',
      );
    }
    // Derived, so no new secret has to be provisioned, and never equal to the data key.
    this.stateKey = Buffer.from(
      hkdfSync('sha256', config.getOrThrow<string>('payments.encryptionKey'), '', 'gateway-oauth-state', 32),
    );
  }

  /** Platform credentials. */
  get platform(): PaymentGatewaysConfig {
    return this.app.paymentGateways;
  }

  /**
   * Whether a gateway can be used in this deployment.
   *
   * @param provider Gateway.
   * @returns OAuth gateways need their platform variables and `PUBLIC_BASE_URL`;
   *   keys gateways need nothing from the platform.
   */
  available(provider: GatewayProvider): boolean {
    if (!isOAuthGateway(provider)) {
      return true;
    }
    const creds = provider === 'STRIPE' ? this.platform.stripe : this.platform.mercadoPago;
    return creds !== null && this.app.publicBaseUrl !== null;
  }

  /**
   * Every gateway and whether this tenant can charge with it (`GET /gateways`).
   *
   * @returns The rows, Netpay first.
   */
  async status(): Promise<GatewayStatusView[]> {
    const netpay = await this.paymentConfig.getCurrent().catch((error: unknown) => {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    });
    const accounts = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentGatewayAccount.findMany({ select: accountSelect }),
    );
    return [
      {
        provider: 'NETPAY',
        auth: 'keys',
        available: true,
        connected: netpay?.enabled === true,
        environment: netpay?.environment ?? null,
      },
      ...GATEWAY_PROVIDERS.map((provider) =>
        this.view(
          provider,
          accounts.find((a) => a.provider === provider),
        ),
      ),
    ];
  }

  /**
   * Starts the OAuth connection of the current tenant.
   *
   * @param provider Stripe or Mercado Pago.
   * @param returnUrl Where the callback sends the merchant back.
   * @returns The gateway's authorization URL.
   * @throws {ReturnUrlNotAllowedException} 422 when `returnUrl` is not on an allowed origin.
   */
  async connect(provider: GatewayProvider, returnUrl: string): Promise<{ authorizeUrl: string }> {
    if (!isOAuthGateway(provider)) {
      throw new ValidationException(`${provider} is connected with its API keys (PUT credentials).`);
    }
    this.assertAvailable(provider);
    if (!isAllowedReturnUrl(returnUrl, this.platform.returnOrigins)) {
      throw new ReturnUrlNotAllowedException(
        'returnUrl',
        safeOrigin(returnUrl),
        'returnUrl must be on an origin listed in PAYMENT_GATEWAY_RETURN_ORIGINS.',
      );
    }
    if (provider === 'STRIPE' && this.stripePlatformMode()) {
      return { authorizeUrl: await this.connectPlatformAccount(returnUrl) };
    }
    const state = signOAuthState(
      this.stateKey,
      { tenantId: this.requestContext.requireTenant().id, provider, returnUrl },
      Date.now(),
    );
    const redirectUri = this.callbackUrl(provider);
    if (provider === 'STRIPE') {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: this.platform.stripe?.clientId ?? '',
        scope: 'read_write',
        state,
        redirect_uri: redirectUri,
      });
      return { authorizeUrl: `${STRIPE_CONNECT}/oauth/authorize?${query.toString()}` };
    }
    const query = new URLSearchParams({
      client_id: this.platform.mercadoPago?.clientId ?? '',
      response_type: 'code',
      platform_id: 'mp',
      state,
      redirect_uri: redirectUri,
    });
    return { authorizeUrl: `${MP_AUTHORIZE}?${query.toString()}` };
  }

  /** Stripe runs without Connect: the platform account itself is the merchant (staging only). */
  stripePlatformMode(): boolean {
    return this.platform.stripe !== null && this.platform.stripe.clientId === null;
  }

  private platformAccount: string | null = null;

  /**
   * The id of the platform's own Stripe account (`GET /v1/account`), cached in memory.
   *
   * @returns `acct_…`.
   */
  async platformAccountId(): Promise<string> {
    if (this.platformAccount === null) {
      const account = await this.call<{ id?: string }>('Stripe', `${STRIPE_API}/v1/account`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.platform.stripe?.secretKey ?? ''}` },
      });
      if (!/^acct_[A-Za-z0-9]+$/.test(account.id ?? '')) {
        throw new UpstreamProviderException('Stripe', 'Stripe did not name the platform account.');
      }
      this.platformAccount = account.id as string;
    }
    return this.platformAccount;
  }

  /**
   * Connects the calling tenant to the platform account without OAuth.
   *
   * @returns The return URL with `gateway=stripe&status=connected` appended.
   * @throws {GatewayAccountInUseException} 409 when another tenant already holds the account.
   */
  private async connectPlatformAccount(returnUrl: string): Promise<string> {
    const tenant = this.requestContext.requireTenant();
    const accountId = await this.platformAccountId();
    const existing = await this.controlPlane.client.paymentGatewayRoute.findUnique({
      where: { externalAccountId: accountId },
      select: { tenantId: true, revokedAt: true },
    });
    if (existing !== null && existing.tenantId !== tenant.id && existing.revokedAt === null) {
      throw new GatewayAccountInUseException('STRIPE');
    }
    await this.storeAccount(
      { schemaName: tenant.schemaName, tenantId: tenant.id },
      'STRIPE',
      {
        externalAccountId: accountId,
        environment: 'SANDBOX',
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        tokenExpiresAt: null,
        publicKey: null,
        webhookId: null,
        connectedAt: new Date(),
      },
      accountId,
    );
    return withQuery(returnUrl, { gateway: 'stripe', status: 'connected' });
  }

  /**
   * Finishes an OAuth connection (public callback).
   *
   * The signed `state` is the only thing tying the callback to a tenant and to a
   * return URL; without a valid one nothing is redirected anywhere. The outcome is
   * appended to the return URL's own query (`gateway`, `status`, `reason`).
   *
   * @param provider Gateway from the path.
   * @param query `code`, `state` and the gateway's `error`, if any.
   * @returns The URL to redirect the merchant to.
   * @throws {ValidationException} When the state is forged, expired or for another gateway.
   */
  async completeOAuth(
    provider: GatewayProvider,
    query: { code?: string; state?: string; error?: string },
  ): Promise<string> {
    const state = verifyOAuthState(this.stateKey, query.state, Date.now());
    if (state === null || state.p !== provider) {
      throw new ValidationException('The OAuth state is invalid or expired.');
    }
    const gateway = provider.toLowerCase();
    const fail = (reason: string): string =>
      withQuery(state.r, {
        gateway,
        status: 'error',
        reason: reason.replace(/[^a-z_]/gi, '').slice(0, 40) || 'error',
      });
    if (query.error !== undefined || query.code === undefined || query.code === '') {
      return fail(query.error ?? 'missing_code');
    }
    if (!this.available(state.p)) {
      return fail('unavailable');
    }
    const tenant = await this.controlPlane.client.tenant.findUnique({
      where: { id: state.t },
      select: { schemaName: true, status: true },
    });
    if (tenant === null || tenant.status !== 'ACTIVE') {
      return fail('tenant_unavailable');
    }
    const scope: GatewayScope = { schemaName: tenant.schemaName, tenantId: state.t };
    let account: AccountFields;
    try {
      account = await this.exchangeCode(scope, state.p, query.code);
    } catch (error) {
      this.logger.warn({
        event: 'gateway_oauth_failed',
        provider,
        tenantId: state.t,
        message: String(error),
      });
      return fail('exchange_failed');
    }
    const existing = await this.controlPlane.client.paymentGatewayRoute.findUnique({
      where: { externalAccountId: account.externalAccountId },
      select: { tenantId: true, revokedAt: true },
    });
    if (existing !== null && existing.tenantId !== state.t && existing.revokedAt === null) {
      // One gateway account routes to one tenant; a second tenant would receive the first one's webhooks.
      return fail('account_in_use');
    }
    await this.storeAccount(scope, state.p, account, account.externalAccountId);
    this.logger.log({ event: 'gateway_connected', provider, tenantId: state.t });
    return withQuery(state.r, { gateway, status: 'connected' });
  }

  /**
   * Stores a keys gateway's credentials for the current tenant (D8).
   *
   * The keys are proven against the gateway first, then encrypted. A fresh opaque
   * webhook token is routed to the tenant and its URL registered with the gateway;
   * a registration that fails is logged and left to reconciliation.
   *
   * @param provider Conekta or Openpay.
   * @param keys Keys as pasted. Never logged or returned.
   * @returns The provider's `GET /gateways` row.
   * @throws {GatewayCredentialsInvalidException} 422 when the gateway refuses them.
   */
  async saveCredentials(provider: GatewayProvider, keys: GatewayKeys): Promise<GatewayStatusView> {
    if (isOAuthGateway(provider)) {
      throw new ValidationException(`${provider} is connected through OAuth (POST connect).`);
    }
    const adapter = KEYS_ADAPTERS[provider];
    const tenant = this.requestContext.requireTenant();
    const scope: GatewayScope = { schemaName: tenant.schemaName, tenantId: tenant.id };
    let proven: Awaited<ReturnType<typeof adapter.validateKeys>>;
    try {
      proven = await adapter.validateKeys(this.http(provider, false), keys);
    } catch (error) {
      if (error instanceof ValidationException || error instanceof GatewayRequestError) {
        throw new GatewayCredentialsInvalidException(provider);
      }
      throw error;
    }
    const previous = await this.accountIn(scope.schemaName, provider);
    if (previous !== null) {
      await this.dropWebhook(scope, provider, previous);
    }
    const token = PaymentSecretBox.generateToken();
    const account: AccountFields = {
      ...proven,
      accessTokenCiphertext: this.secretBox.encrypt(
        keys.privateKey,
        PaymentSecretBox.aadForGateway(scope.tenantId, provider, 'access'),
      ),
      refreshTokenCiphertext: null,
      tokenExpiresAt: null,
      webhookId: null,
      connectedAt: new Date(),
    };
    await this.storeAccount(scope, provider, account, PaymentSecretBox.hashToken(token));
    const base = this.app.publicBaseUrl;
    if (base !== null) {
      try {
        const call = await this.callFor(scope, provider);
        const webhookId = await adapter.registerWebhook(
          call,
          `${base}/${this.app.apiPrefix}/payments/gateway-webhook/${provider.toLowerCase()}/${token}`,
        );
        await this.tenantPrisma.forCurrentTenantTransaction((client) =>
          client.paymentGatewayAccount.update({ where: { provider }, data: { webhookId } }),
        );
      } catch (error) {
        this.logger.warn({
          event: 'gateway_webhook_register_failed',
          provider,
          tenantId: scope.tenantId,
          message: String(error),
        });
      }
    }
    this.logger.log({ event: 'gateway_connected', provider, tenantId: scope.tenantId });
    return this.view(provider, (await this.accountIn(scope.schemaName, provider)) ?? undefined);
  }

  /**
   * Disconnects the current tenant's account. Stripe is deauthorized; a keys
   * gateway's webhook is deleted when possible; stored secrets are erased.
   *
   * @param provider Gateway.
   * @returns The new state.
   */
  async disconnect(provider: GatewayProvider): Promise<{ provider: GatewayProvider; connected: false }> {
    const tenant = this.requestContext.requireTenant();
    const scope: GatewayScope = { schemaName: tenant.schemaName, tenantId: tenant.id };
    const row = await this.accountIn(scope.schemaName, provider);
    if (row !== null && row.disconnectedAt === null) {
      if (provider === 'STRIPE' && this.platform.stripe?.clientId) {
        try {
          await this.call('Stripe', `${STRIPE_CONNECT}/oauth/deauthorize`, {
            method: 'POST',
            headers: this.stripeHeaders(),
            body: toStripeForm({
              client_id: this.platform.stripe.clientId,
              stripe_user_id: row.externalAccountId,
            }),
          });
        } catch (error) {
          // Already deauthorized from the Stripe dashboard: the goal is reached.
          if (!(error instanceof GatewayRequestError)) {
            throw error;
          }
        }
      }
      await this.dropWebhook(scope, provider, row);
      const now = new Date();
      await this.tenantPrisma.forCurrentTenantTransaction((client) =>
        client.paymentGatewayAccount.update({
          where: { provider },
          data: {
            disconnectedAt: now,
            accessTokenCiphertext: null,
            refreshTokenCiphertext: null,
            webhookId: null,
          },
        }),
      );
      await this.controlPlane.client.paymentGatewayRoute.updateMany({
        where: { provider, tenantId: tenant.id, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    return { provider, connected: false };
  }

  /**
   * The tenant a webhook belongs to.
   *
   * @param provider Gateway.
   * @param externalAccountId `acct_…` / MP `user_id`, or the SHA-256 of a webhook token.
   * @returns Tenant and schema, or `null` when not routed.
   */
  async resolveRoute(provider: GatewayProvider, externalAccountId: string): Promise<GatewayScope | null> {
    const route = await this.controlPlane.client.paymentGatewayRoute.findUnique({
      where: { externalAccountId },
      select: { provider: true, tenantId: true, schemaName: true, revokedAt: true },
    });
    if (route === null || route.provider !== provider || route.revokedAt !== null) {
      return null;
    }
    return { schemaName: route.schemaName, tenantId: route.tenantId };
  }

  /**
   * Records that the merchant deauthorized the platform from Stripe's side.
   *
   * @param scope Tenant.
   * @param externalAccountId `acct_…`.
   */
  async markDeauthorized(scope: GatewayScope, externalAccountId: string): Promise<void> {
    const now = new Date();
    await this.tenantPrisma.forTenantTransaction(scope.schemaName, (client) =>
      client.paymentGatewayAccount.updateMany({
        where: { provider: 'STRIPE', externalAccountId, disconnectedAt: null },
        data: { disconnectedAt: now },
      }),
    );
    await this.controlPlane.client.paymentGatewayRoute.updateMany({
      where: { externalAccountId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /**
   * Environment of the connected account, for a new order.
   *
   * @param scope Tenant.
   * @param provider Gateway.
   * @returns `SANDBOX` or `LIVE`.
   * @throws {GatewayNotConnectedException} When the tenant has not connected it.
   */
  async connectedEnvironment(scope: GatewayScope, provider: GatewayProvider): Promise<'SANDBOX' | 'LIVE'> {
    this.assertAvailable(provider);
    return (await this.callFor(scope, provider)).environment;
  }

  /**
   * Creates the hosted checkout of an order on its gateway.
   *
   * @param scope Tenant.
   * @param provider Gateway.
   * @param order What to charge.
   * @returns The checkout's id and the URL to send the buyer to.
   */
  async createHostedCheckout(
    scope: GatewayScope,
    provider: GatewayProvider,
    order: {
      orderId: string;
      orderReference: string;
      title: string;
      amount: string;
      successUrl: string;
      cancelUrl: string;
      saveCard: boolean;
      buyer: { name: string; email: string; phone?: string } | null;
    },
  ): Promise<{ sessionId: string; url: string }> {
    const base = this.app.publicBaseUrl;
    return GATEWAY_ADAPTERS[provider].createCheckout(await this.callFor(scope, provider), {
      ...order,
      expiresAt: new Date(Date.now() + GATEWAY_CHECKOUT_TTL_MS),
      idempotencyKey: `bn-checkout-${order.orderId}`,
      notificationUrl:
        base === null
          ? null
          : `${base}/${this.app.apiPrefix}/payments/gateway-webhook/${provider.toLowerCase()}`,
    });
  }

  /**
   * What the gateway knows about an order's payment.
   *
   * @param scope Tenant.
   * @param provider Gateway.
   * @param ref Known ids of the order.
   * @returns The mapped transaction, or `null` when the buyer has not paid yet.
   */
  async lookup(
    scope: GatewayScope,
    provider: GatewayProvider,
    ref: { transactionId: string | null; sessionId: string | null; orderReference: string },
  ): Promise<GatewayLookup | null> {
    // Existing orders keep using the account they were paid on; the gateway refuses once deauthorized.
    return GATEWAY_ADAPTERS[provider].lookup(await this.callFor(scope, provider, true), ref);
  }

  /**
   * Refunds (part of) a gateway payment.
   *
   * @param scope Tenant.
   * @param provider Gateway.
   * @param transactionId The gateway's id.
   * @param amount Two-decimal amount.
   * @param idempotencyKey Same key for the same refund, where the gateway honours one.
   */
  async refund(
    scope: GatewayScope,
    provider: GatewayProvider,
    transactionId: string,
    amount: string,
    idempotencyKey: string,
  ): Promise<void> {
    await GATEWAY_ADAPTERS[provider].refund(
      await this.callFor(scope, provider, true),
      transactionId,
      amount,
      idempotencyKey,
    );
  }

  /**
   * Charges a saved Stripe card with the buyer absent (`off_session`; D6).
   *
   * A decline is a 402 that still names the PaymentIntent; it is returned like a
   * success so the caller records the declined transaction.
   *
   * @param scope Tenant.
   * @param input Order and saved card.
   * @returns The PaymentIntent.
   */
  async chargeStoredStripe(
    scope: GatewayScope,
    input: {
      orderReference: string;
      amount: string;
      currency: string;
      description: string;
      customer: string;
      paymentMethod: string;
      idempotencyKey: string;
    },
  ): Promise<StripePaymentIntent> {
    const call = await this.callFor(scope, 'STRIPE', true);
    try {
      return await stripeRequest<StripePaymentIntent>(call, 'POST', '/v1/payment_intents', {
        idempotencyKey: input.idempotencyKey,
        form: {
          amount: toCents(input.amount),
          currency: input.currency.toLowerCase(),
          customer: input.customer,
          payment_method: input.paymentMethod,
          off_session: true,
          confirm: true,
          description: input.description,
          metadata: { [STRIPE_ORDER_METADATA_KEY]: input.orderReference },
        },
      });
    } catch (error) {
      const declined =
        error instanceof GatewayRequestError
          ? (error.body as { error?: { payment_intent?: StripePaymentIntent } })
          : null;
      if (typeof declined?.error?.payment_intent?.id === 'string') {
        return declined.error.payment_intent;
      }
      throw error;
    }
  }

  /** The `GET /gateways` row of one gateway. */
  private view(provider: GatewayProvider, row: AccountRow | undefined): GatewayStatusView {
    const live = row !== undefined && row.disconnectedAt === null ? row : null;
    const adapter = GATEWAY_ADAPTERS[provider];
    return {
      provider,
      auth: adapter.auth,
      available: this.available(provider),
      connected: live !== null,
      environment: live === null ? null : (live.environment as 'SANDBOX' | 'LIVE'),
      accountId: live?.externalAccountId ?? null,
      connectedAt: live?.connectedAt.toISOString() ?? null,
      supportsAutopay: adapter.supportsAutopay,
    };
  }

  /**
   * Writes the tenant's account and routes `routeKey` to it, revoking whatever
   * routed this tenant's gateway before.
   */
  private async storeAccount(
    scope: GatewayScope,
    provider: GatewayProvider,
    account: AccountFields,
    routeKey: string,
  ): Promise<void> {
    const now = new Date();
    await this.controlPlane.client.paymentGatewayRoute.updateMany({
      where: { tenantId: scope.tenantId, provider, revokedAt: null, externalAccountId: { not: routeKey } },
      data: { revokedAt: now },
    });
    await this.controlPlane.client.paymentGatewayRoute.upsert({
      where: { externalAccountId: routeKey },
      create: {
        provider,
        externalAccountId: routeKey,
        tenantId: scope.tenantId,
        schemaName: scope.schemaName,
      },
      update: { provider, tenantId: scope.tenantId, schemaName: scope.schemaName, revokedAt: null },
    });
    await this.tenantPrisma.forTenantTransaction(scope.schemaName, (client) =>
      client.paymentGatewayAccount.upsert({
        where: { provider },
        create: { ...account, provider, disconnectedAt: null },
        update: { ...account, disconnectedAt: null },
      }),
    );
  }

  /** Best effort: deletes the webhook registered with a keys gateway. */
  private async dropWebhook(scope: GatewayScope, provider: GatewayProvider, row: AccountRow): Promise<void> {
    if (isOAuthGateway(provider) || row.webhookId === null || row.accessTokenCiphertext === null) {
      return;
    }
    try {
      await KEYS_ADAPTERS[provider].deleteWebhook(await this.callFor(scope, provider, true), row.webhookId);
    } catch (error) {
      this.logger.warn({
        event: 'gateway_webhook_delete_failed',
        provider,
        tenantId: scope.tenantId,
        message: String(error),
      });
    }
  }

  /** Trades an OAuth code for the account row to store. */
  private async exchangeCode(
    scope: GatewayScope,
    provider: OAuthGatewayProvider,
    code: string,
  ): Promise<AccountFields> {
    const now = new Date();
    if (provider === 'STRIPE') {
      const token = await this.call<{ stripe_user_id: string; livemode?: boolean }>(
        'Stripe',
        `${STRIPE_CONNECT}/oauth/token`,
        {
          method: 'POST',
          headers: this.stripeHeaders(),
          body: toStripeForm({ grant_type: 'authorization_code', code }),
        },
      );
      if (!/^acct_[A-Za-z0-9]+$/.test(token.stripe_user_id ?? '')) {
        throw new Error('Stripe answered without an account id.');
      }
      return {
        externalAccountId: token.stripe_user_id,
        environment: token.livemode === true ? 'LIVE' : 'SANDBOX',
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        tokenExpiresAt: null,
        publicKey: null,
        webhookId: null,
        connectedAt: now,
      };
    }
    const creds = this.platform.mercadoPago;
    const token = await this.call<MercadoPagoToken>('Mercado Pago', `${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: creds?.clientId,
        client_secret: creds?.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl(provider),
      }),
    });
    return { ...this.mercadoPagoTokenRow(scope, token, now), webhookId: null, connectedAt: now };
  }

  private mercadoPagoTokenRow(
    scope: GatewayScope,
    token: MercadoPagoToken,
    now: Date,
  ): Omit<AccountFields, 'webhookId' | 'connectedAt'> {
    if (typeof token.access_token !== 'string' || !/^\d+$/.test(String(token.user_id))) {
      throw new Error('Mercado Pago answered without a token or user id.');
    }
    return {
      externalAccountId: String(token.user_id),
      environment: token.live_mode === true ? 'LIVE' : 'SANDBOX',
      accessTokenCiphertext: this.secretBox.encrypt(
        token.access_token,
        PaymentSecretBox.aadForGateway(scope.tenantId, 'MERCADOPAGO', 'access'),
      ),
      refreshTokenCiphertext:
        typeof token.refresh_token === 'string'
          ? this.secretBox.encrypt(
              token.refresh_token,
              PaymentSecretBox.aadForGateway(scope.tenantId, 'MERCADOPAGO', 'refresh'),
            )
          : null,
      tokenExpiresAt: new Date(now.getTime() + (token.expires_in ?? 15_552_000) * 1000),
      publicKey: token.public_key ?? null,
    };
  }

  /**
   * The authenticated call an adapter needs: the account and its secret.
   *
   * @param scope Tenant.
   * @param provider Gateway.
   * @param allowDisconnected `true` for operations on existing orders.
   * @returns The call.
   * @throws {GatewayNotConnectedException} 409 when there is no usable account.
   */
  private async callFor(
    scope: GatewayScope,
    provider: GatewayProvider,
    allowDisconnected = false,
  ): Promise<GatewayCall> {
    const account = await this.accountIn(scope.schemaName, provider);
    if (account === null || (!allowDisconnected && account.disconnectedAt !== null)) {
      throw new GatewayNotConnectedException(provider);
    }
    let secret: string;
    if (provider === 'STRIPE') {
      if (this.platform.stripe === null) {
        throw new GatewayNotConnectedException(provider, 'Stripe is not available in this deployment.');
      }
      secret = this.platform.stripe.secretKey;
    } else if (account.accessTokenCiphertext === null) {
      throw new GatewayNotConnectedException(provider);
    } else if (provider === 'MERCADOPAGO') {
      secret = await this.mercadoPagoToken(scope, account, account.accessTokenCiphertext);
    } else {
      secret = this.secretBox.decrypt(
        account.accessTokenCiphertext,
        PaymentSecretBox.aadForGateway(scope.tenantId, provider, 'access'),
      );
    }
    return {
      externalAccountId: account.externalAccountId,
      environment: account.environment === 'LIVE' ? 'LIVE' : 'SANDBOX',
      secret,
      ...(provider === 'STRIPE' && this.stripePlatformMode() ? { stripePlatformMode: true } : {}),
      http: this.http(provider, true),
    };
  }

  /**
   * The seller's Mercado Pago access token, refreshed when it is about to expire.
   *
   * shortcut: two instances refreshing at the same moment both call Mercado Pago and the last
   * write wins; add a row lock if Mercado Pago starts invalidating the older refresh token.
   */
  private async mercadoPagoToken(
    scope: GatewayScope,
    account: AccountRow,
    accessCiphertext: string,
  ): Promise<string> {
    const creds = this.platform.mercadoPago;
    const now = new Date();
    if (
      creds !== null &&
      account.refreshTokenCiphertext !== null &&
      account.tokenExpiresAt !== null &&
      account.tokenExpiresAt.getTime() - now.getTime() < MP_REFRESH_BEFORE_MS
    ) {
      const refreshToken = this.secretBox.decrypt(
        account.refreshTokenCiphertext,
        PaymentSecretBox.aadForGateway(scope.tenantId, 'MERCADOPAGO', 'refresh'),
      );
      const token = await this.call<MercadoPagoToken>('Mercado Pago', `${MP_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      const row = this.mercadoPagoTokenRow(scope, token, now);
      await this.tenantPrisma.forTenantTransaction(scope.schemaName, (client) =>
        client.paymentGatewayAccount.update({ where: { provider: 'MERCADOPAGO' }, data: row }),
      );
      return token.access_token;
    }
    return this.secretBox.decrypt(
      accessCiphertext,
      PaymentSecretBox.aadForGateway(scope.tenantId, 'MERCADOPAGO', 'access'),
    );
  }

  private accountIn(schemaName: string, provider: GatewayProvider): Promise<AccountRow | null> {
    return this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentGatewayAccount.findUnique({ where: { provider }, select: accountSelect }),
    );
  }

  private assertAvailable(provider: GatewayProvider): void {
    if (!this.available(provider)) {
      throw new ValidationException(`${provider} is not available in this deployment.`);
    }
  }

  private callbackUrl(provider: OAuthGatewayProvider): string {
    return `${this.app.publicBaseUrl}/${this.app.apiPrefix}/payments/gateways/oauth/${provider.toLowerCase()}/callback`;
  }

  private stripeHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.platform.stripe?.secretKey ?? ''}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  /**
   * The HTTP function handed to an adapter.
   *
   * @param provider Gateway, for error messages.
   * @param accountScoped On a connected account a 401/403 means the account no
   *   longer authorises us (409 `GATEWAY_NOT_CONNECTED`); while validating keys it
   *   means the keys are wrong, so it is left as is.
   * @returns The function.
   */
  private http(provider: GatewayProvider, accountScoped: boolean): GatewayHttp {
    return async <T>(
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      try {
        return await this.call<T>(provider, url, init);
      } catch (error) {
        if (
          accountScoped &&
          error instanceof GatewayRequestError &&
          (error.providerStatus === 401 || error.providerStatus === 403)
        ) {
          throw new GatewayNotConnectedException(
            provider,
            `${provider} no longer authorises this platform on the account.`,
          );
        }
        throw error;
      }
    };
  }

  /**
   * Sends one request and classifies the outcome the way the Netpay client does
   * (BN-REQ-PAY-011): no answer, a 5xx or an unreadable body on a write is an
   * unknown outcome (the claim holds); on a read it is a plain upstream failure.
   * A 4xx is a definitive refusal.
   */
  private async call<T>(
    provider: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<T> {
    const write = init.method !== 'GET';
    const unknown = (): AppException =>
      write ? new ProviderOutcomeUnknownException(provider) : new UpstreamProviderException(provider);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
    } catch {
      throw unknown();
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (response.status >= 400 && response.status < 500) {
      throw new GatewayRequestError(provider, response.status, body);
    }
    // A DELETE may answer with an empty body; anything else must be readable.
    if (!response.ok || ((body === null || typeof body !== 'object') && init.method !== 'DELETE')) {
      throw unknown();
    }
    return body as T;
  }
}

/** The columns a connect writes. */
type AccountFields = Omit<AccountRow, 'provider' | 'disconnectedAt'>;

const accountSelect = {
  provider: true,
  externalAccountId: true,
  environment: true,
  accessTokenCiphertext: true,
  refreshTokenCiphertext: true,
  tokenExpiresAt: true,
  publicKey: true,
  webhookId: true,
  connectedAt: true,
  disconnectedAt: true,
} as const;

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
