import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { PaymentSecretBox, buildOrderReference } from './payment-secret-box';
import { NETPAY_HOSTS, type NetpayEnvironment } from './netpay-endpoints';
import type { Prisma } from '../generated/tenant-plane/client';
import {
  CredentialsRejectedException,
  NotFoundException,
  ValidationException,
} from '../common/errors/app.exception';
import { NetpayClient } from './netpay.client';
import { AuditLogService } from '../audit/audit-log.service';
import { auditActorOf } from '../audit/audit-actor';

/** The documented Netpay key format (BN-REQ-API-004), shared with consumers. */
const NETPAY_KEY_PATTERN = /^(pk|sk)_netpay_[A-Za-z0-9]+$/;

/** Currencies a tenant may charge in until it is enabled for more (BN-REQ-PAY-008). */
export const DEFAULT_ALLOWED_CURRENCIES: readonly string[] = ['MXN'];

/** A tenant's stored provider configuration, with the secret still encrypted. */
export interface StoredPaymentConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly environment: NetpayEnvironment;
  readonly publicKey: string;
  readonly secretKeyCiphertext: string;
  readonly orderReferencePrefix: string;
  readonly enabled: boolean;
  /** Per tenant, from 1 (BN-REQ-CFG-002). */
  readonly version: number;
  /** Origins a hosted order may return the buyer to; empty: any `https` origin (BN-REQ-PAY-007). */
  readonly allowedReturnOrigins: readonly string[];
  /** Currencies this tenant may charge in (BN-REQ-PAY-008). */
  readonly allowedCurrencies: readonly string[];
}

/** What a new version is made of. */
interface VersionInput {
  readonly environment: NetpayEnvironment;
  readonly publicKey: string;
  readonly secretKeyCiphertext: string;
  readonly orderReferencePrefix: string;
  readonly allowedReturnOrigins: readonly string[];
  readonly allowedCurrencies: readonly string[];
}

/**
 * Normalises a row as read, so a row written before the versioning columns (or a
 * test double without them) reads with the documented defaults.
 *
 * @param row Selected row.
 * @returns The configuration.
 */
function toStored(row: Record<string, unknown>): StoredPaymentConfig {
  const list = (value: unknown, fallback: readonly string[]): readonly string[] =>
    Array.isArray(value) ? (value as string[]) : fallback;
  return {
    id: row['id'] as string,
    tenantId: row['tenantId'] as string,
    environment: row['environment'] as NetpayEnvironment,
    publicKey: row['publicKey'] as string,
    secretKeyCiphertext: row['secretKeyCiphertext'] as string,
    orderReferencePrefix: row['orderReferencePrefix'] as string,
    enabled: row['enabled'] !== false,
    version: typeof row['version'] === 'number' ? row['version'] : 1,
    allowedReturnOrigins: list(row['allowedReturnOrigins'], []),
    allowedCurrencies: list(row['allowedCurrencies'], DEFAULT_ALLOWED_CURRENCIES),
  };
}

/**
 * Normalises the return-origin allowlist (BN-REQ-PAY-007): each entry must be an
 * `https` origin, without path, query or fragment.
 *
 * @param origins As sent.
 * @returns Lower-cased origins, de-duplicated, in order.
 * @throws {ValidationException} When an entry is not an `https` origin.
 */
export function normaliseReturnOrigins(origins: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of origins) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ValidationException(`allowedReturnOrigins: "${raw}" is not an https origin.`);
    }
    const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '';
    if (url.protocol !== 'https:' || !bare) {
      throw new ValidationException(
        `allowedReturnOrigins: "${raw}" must be an https origin such as https://shop.example.com.`,
      );
    }
    if (!out.includes(url.origin)) {
      out.push(url.origin);
    }
  }
  return out;
}

/**
 * Normalises the currency allowlist (BN-REQ-PAY-008).
 *
 * @param currencies As sent.
 * @returns Upper-case ISO codes, de-duplicated.
 * @throws {ValidationException} When an entry is not a three-letter code or the list is empty.
 */
export function normaliseCurrencies(currencies: readonly string[]): string[] {
  const out = [...new Set(currencies.map((c) => c.trim().toUpperCase()))];
  if (out.length === 0 || out.some((c) => !/^[A-Z]{3}$/.test(c))) {
    throw new ValidationException('allowedCurrencies must be a non-empty list of ISO 4217 codes.');
  }
  return out;
}

/**
 * Reads and writes a tenant's Netpay configuration.
 *
 * The secret key is returned encrypted and decrypted only at the call site that
 * needs to sign a request. It is never part of a response DTO, which is asserted
 * by a test.
 */
@Injectable()
export class PaymentConfigService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly requestContext: RequestContextService,
    private readonly secretBox: PaymentSecretBox,
    private readonly netpay: NetpayClient,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The tenant this service is operating for.
   *
   * @returns Tenant id from the active request context.
   * @throws {Error} When called outside a request with a resolved tenant.
   */
  private currentTenantId(): string {
    const tenant = this.requestContext.get().tenant;
    if (!tenant) {
      throw new ValidationException('No tenant is resolved for this request.');
    }
    return tenant.id;
  }

  /**
   * Reads the tenant's configuration.
   *
   * @returns The configuration.
   * @throws {NotFoundException} When the tenant has none.
   */
  async getCurrent(): Promise<StoredPaymentConfig> {
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentProviderConfig.findFirst(this.activeQuery()),
    );
    if (row === null) {
      throw new NotFoundException('This tenant has no payment provider configured.');
    }
    return toStored(row);
  }

  /**
   * Reads the configuration and decrypts the secret, refusing a disabled tenant.
   *
   * @param configId Version to read: an order's `configId` (BN-REQ-CFG-002). The
   *   active version when absent or `null`.
   * @returns Configuration plus the plaintext secret.
   * @throws {ValidationException} When payments are disabled for the tenant.
   */
  async getUsable(configId?: string | null): Promise<StoredPaymentConfig & { readonly secretKey: string }> {
    return this.getUsableInSchema(this.tenantPrisma.requireCurrentSchema(), configId);
  }

  /**
   * Reads a tenant's configuration from outside its request context.
   *
   * Every operation on an existing order passes the order's `configId`, so a refund
   * or a verification of an order charged on SANDBOX keys keeps using them after the
   * tenant moved to LIVE (BN-REQ-CFG-002).
   *
   * @param schemaName Schema holding the configuration.
   * @param configId Version to read; the active version when absent or `null`.
   * @returns Configuration plus the plaintext secret.
   * @throws {ValidationException} When payments are disabled for the tenant.
   */
  async getUsableInSchema(
    schemaName: string,
    configId?: string | null,
  ): Promise<StoredPaymentConfig & { readonly secretKey: string }> {
    const config = await this.getUsableFrom(schemaName, configId ?? null);
    if (!config.enabled) {
      throw new ValidationException('Payments are disabled for this tenant.');
    }
    return {
      ...config,
      secretKey: this.secretBox.decrypt(
        config.secretKeyCiphertext,
        PaymentSecretBox.aadForConfig(config.tenantId),
      ),
    };
  }

  /**
   * Reads one version, or the active one, in a given schema.
   *
   * @param schemaName Schema to read.
   * @param configId Version id, or `null` for the active version.
   * @returns The configuration.
   */
  private async getUsableFrom(schemaName: string, configId: string | null): Promise<StoredPaymentConfig> {
    const row = await this.tenantPrisma.forTenantTransaction(schemaName, async (client) => {
      if (configId !== null) {
        const pinned = await client.paymentProviderConfig.findFirst({
          where: { id: configId },
          select: this.configSelect(),
        });
        if (pinned !== null) {
          return pinned;
        }
      }
      return client.paymentProviderConfig.findFirst(this.activeQuery());
    });
    if (row === null) {
      throw new NotFoundException('This tenant has no payment provider configured.');
    }
    return toStored(row);
  }

  /**
   * Stores the tenant's configuration as a new version (BN-REQ-CFG-002).
   *
   * Append-only: the previous version stays, inactive, for the orders created on it.
   * A save that changes nothing writes nothing. When the environment or the secret
   * key changes, the inbound webhook token is replaced (returned once), every older
   * token stops resolving and `webhookRegisteredAt` is cleared, so the operator has
   * to register the new URL with Netpay (BN-REQ-CFG-003). Any other change keeps the
   * token and its registration.
   *
   * @param input Keys, environment and optional settings; omitted settings carry over.
   * @returns The active configuration and the new webhook token, if one was issued.
   */
  async save(input: {
    publicKey: string;
    secretKey: string;
    environment: NetpayEnvironment;
    orderReferencePrefix?: string;
    allowedReturnOrigins?: readonly string[];
    allowedCurrencies?: readonly string[];
  }): Promise<{ config: StoredPaymentConfig; webhookToken: string | null }> {
    if (!input.publicKey.startsWith('pk_netpay_')) {
      throw new ValidationException('The Netpay public key must start with pk_netpay_.');
    }
    if (!input.secretKey.startsWith('sk_netpay_')) {
      throw new ValidationException('The Netpay secret key must start with sk_netpay_.');
    }
    if (!NETPAY_KEY_PATTERN.test(input.publicKey) || !NETPAY_KEY_PATTERN.test(input.secretKey)) {
      throw new ValidationException('Netpay keys must match ^(pk|sk)_netpay_[A-Za-z0-9]+$.');
    }
    const origins =
      input.allowedReturnOrigins === undefined
        ? undefined
        : normaliseReturnOrigins(input.allowedReturnOrigins);
    const currencies =
      input.allowedCurrencies === undefined ? undefined : normaliseCurrencies(input.allowedCurrencies);
    // Proven against Netpay before anything is stored (BN-TASK-025).
    await this.assertCredentialsWork(input.environment, input.secretKey);
    const tenantId = this.currentTenantId();
    const existing = await this.getOptional();
    const aad = PaymentSecretBox.aadForConfig(tenantId);
    const previousSecret =
      existing === null ? null : this.secretBox.decrypt(existing.secretKeyCiphertext, aad);
    const next: VersionInput = {
      environment: input.environment,
      publicKey: input.publicKey,
      secretKeyCiphertext:
        previousSecret === input.secretKey && existing !== null
          ? existing.secretKeyCiphertext
          : this.secretBox.encrypt(input.secretKey, aad),
      orderReferencePrefix:
        input.orderReferencePrefix ?? existing?.orderReferencePrefix ?? tenantId.slice(0, 8),
      allowedReturnOrigins: origins ?? existing?.allowedReturnOrigins ?? [],
      allowedCurrencies: currencies ?? existing?.allowedCurrencies ?? DEFAULT_ALLOWED_CURRENCIES,
    };
    const secretKeyChanged = previousSecret !== input.secretKey;
    if (existing !== null && !secretKeyChanged && sameSettings(existing, next)) {
      return { config: existing, webhookToken: null };
    }
    // A first configuration mints the inbound webhook token here, and so does a
    // change of environment or secret: the URL registered with Netpay belongs to
    // the old key set, so the token goes with it. It is returned once and routed
    // below, because the token is the only thing that can resolve an unsigned
    // notification to this tenant.
    const rotate = existing === null || secretKeyChanged || existing.environment !== input.environment;
    const webhookToken = rotate ? PaymentSecretBox.generateToken() : null;
    const config = await this.appendVersion(tenantId, next, webhookToken);
    if (webhookToken !== null) {
      await this.routeWebhookToken(webhookToken, config, existing !== null);
    }
    await this.audited(existing === null ? 'payment.config_created' : 'payment.config_updated', config.id, {
      from:
        existing === null
          ? null
          : { environment: existing.environment, publicKey: existing.publicKey, version: existing.version },
      to: { environment: config.environment, publicKey: config.publicKey },
      version: config.version,
      orderReferencePrefix: config.orderReferencePrefix,
      allowedReturnOrigins: config.allowedReturnOrigins,
      allowedCurrencies: config.allowedCurrencies,
      // Whether the secret changed, never the secret.
      secretKeyChanged: existing === null || secretKeyChanged,
      webhookTokenReplaced: webhookToken !== null,
    });
    return { config, webhookToken };
  }

  /**
   * Changes the allowlists alone, as a new version that keeps the keys and the
   * webhook token (BN-TASK-021/022).
   *
   * @param input Settings to change; omitted ones carry over.
   * @returns The new active configuration.
   * @throws {NotFoundException} When the tenant has no configuration yet.
   */
  async updateSettings(input: {
    allowedReturnOrigins?: readonly string[];
    allowedCurrencies?: readonly string[];
  }): Promise<{ config: StoredPaymentConfig }> {
    const existing = await this.getCurrent();
    const next: VersionInput = {
      environment: existing.environment,
      publicKey: existing.publicKey,
      secretKeyCiphertext: existing.secretKeyCiphertext,
      orderReferencePrefix: existing.orderReferencePrefix,
      allowedReturnOrigins:
        input.allowedReturnOrigins === undefined
          ? existing.allowedReturnOrigins
          : normaliseReturnOrigins(input.allowedReturnOrigins),
      allowedCurrencies:
        input.allowedCurrencies === undefined
          ? existing.allowedCurrencies
          : normaliseCurrencies(input.allowedCurrencies),
    };
    if (sameSettings(existing, next)) {
      return { config: existing };
    }
    const config = await this.appendVersion(existing.tenantId, next, null);
    await this.audited('payment.config_updated', config.id, {
      from: { version: existing.version },
      version: config.version,
      allowedReturnOrigins: config.allowedReturnOrigins,
      allowedCurrencies: config.allowedCurrencies,
      secretKeyChanged: false,
      webhookTokenReplaced: false,
    });
    return { config };
  }

  /**
   * Writes the next version and makes it the only active one, in one transaction.
   *
   * The partial unique index on `active` means two concurrent saves cannot both
   * end up active: the second one fails instead of leaving two.
   *
   * @param tenantId Tenant.
   * @param next The new version's content.
   * @param webhookToken New inbound token, or `null` to carry the previous one over.
   * @returns The new version.
   */
  private async appendVersion(
    tenantId: string,
    next: VersionInput,
    webhookToken: string | null,
  ): Promise<StoredPaymentConfig> {
    const now = new Date();
    const row = await this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      const previous = await client.paymentProviderConfig.findFirst({
        where: { active: true },
        orderBy: { version: 'desc' },
        select: { version: true, webhookTokenHash: true, webhookRegisteredAt: true, enabled: true },
      });
      if (previous === null && webhookToken === null) {
        throw new ValidationException('A first configuration needs a webhook token.');
      }
      await client.paymentProviderConfig.updateMany({ where: { active: true }, data: { active: false } });
      return client.paymentProviderConfig.create({
        data: {
          tenantId,
          environment: next.environment as never,
          publicKey: next.publicKey,
          secretKeyCiphertext: next.secretKeyCiphertext,
          orderReferencePrefix: next.orderReferencePrefix,
          allowedReturnOrigins: [...next.allowedReturnOrigins],
          allowedCurrencies: [...next.allowedCurrencies],
          version: (previous?.version ?? 0) + 1,
          active: true,
          enabled: previous?.enabled ?? true,
          webhookTokenHash:
            webhookToken === null
              ? (previous?.webhookTokenHash as string)
              : PaymentSecretBox.hashToken(webhookToken),
          // A new token means a new URL that Netpay does not know yet.
          webhookRegisteredAt: webhookToken === null ? (previous?.webhookRegisteredAt ?? null) : null,
          createdAt: now,
          updatedAt: now,
        },
        select: this.configSelect(),
      });
    });
    return toStored(row);
  }

  /**
   * Proves a secret key against the selected environment.
   *
   * Netpay keys carry no environment marker (both are `sk_netpay_…`), so the only
   * reliable check is to ask: a read-only authenticated call in the selected
   * environment. When it is refused, the other environment is asked too, so a live
   * key saved as sandbox (or the reverse) gets a specific, actionable error.
   *
   * @param environment Environment the operator selected.
   * @param secretKey Key to prove.
   * @throws {CredentialsRejectedException} 422 `CREDENTIALS_ENVIRONMENT_MISMATCH` or
   *   `CREDENTIALS_INVALID`.
   */
  private async assertCredentialsWork(environment: NetpayEnvironment, secretKey: string): Promise<void> {
    if ((await this.netpay.checkCredentials(environment, secretKey)) === 'VALID') {
      return;
    }
    const other: NetpayEnvironment = environment === 'SANDBOX' ? 'LIVE' : 'SANDBOX';
    const elsewhere = await this.netpay.checkCredentials(other, secretKey).catch(() => 'INVALID' as const);
    if (elsewhere === 'VALID') {
      throw new CredentialsRejectedException(
        'CREDENTIALS_ENVIRONMENT_MISMATCH',
        `These Netpay keys belong to the ${other} environment, not ${environment}.`,
      );
    }
    throw new CredentialsRejectedException(
      'CREDENTIALS_INVALID',
      `Netpay refused these keys in ${environment}.`,
    );
  }

  /**
   * Routes a token to this tenant in the control-plane table.
   *
   * @param token Opaque token.
   * @param config Configuration the token belongs to.
   * @param retireOthers Whether every other token of the tenant stops resolving.
   */
  private async routeWebhookToken(
    token: string,
    config: StoredPaymentConfig,
    retireOthers: boolean,
  ): Promise<void> {
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const tokenHash = PaymentSecretBox.hashToken(token);
    await this.controlPlane.client.paymentWebhookRegistry.upsert({
      where: { tokenHash },
      update: { environment: config.environment as never, revokedAt: null, schemaName },
      create: {
        tenantId: config.tenantId,
        schemaName,
        tokenHash,
        environment: config.environment as never,
      },
    });
    if (retireOthers) {
      // Without this the URL of the previous key set would keep resolving.
      await this.controlPlane.client.paymentWebhookRegistry.updateMany({
        where: { tenantId: config.tenantId, tokenHash: { not: tokenHash }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  /**
   * Issues a fresh inbound webhook token and returns it once.
   *
   * The plaintext is never stored, only its hash, so a database disclosure does
   * not yield a usable webhook credential.
   *
   * @returns The token, to be shown to the operator exactly once.
   */
  async rotateWebhookToken(): Promise<{ token: string; urlPath: string }> {
    const config = await this.getCurrent();
    const token = PaymentSecretBox.generateToken();
    const tokenHash = PaymentSecretBox.hashToken(token);
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentProviderConfig.update({
        where: { id: config.id },
        // The new URL is not registered with Netpay yet, and any drift verdict was about the old one.
        data: {
          webhookTokenHash: tokenHash,
          webhookRegisteredAt: null,
          webhookDrift: null,
          webhookDriftCheckedAt: null,
          updatedAt: new Date(),
        },
      }),
    );
    // The routing entry is what makes the token resolvable: the notification is
    // unsigned, so nothing in the payload can tell us which tenant it belongs to.
    await this.controlPlane.client.paymentWebhookRegistry.upsert({
      where: { tokenHash },
      update: { environment: config.environment as never, revokedAt: null, schemaName },
      create: {
        tenantId: config.tenantId,
        schemaName,
        tokenHash,
        environment: config.environment as never,
      },
    });
    // Rotation retires every earlier token for this tenant. Without this the old
    // URL would keep resolving, and "rotate" would only ever add a way in.
    await this.controlPlane.client.paymentWebhookRegistry.updateMany({
      where: { tenantId: config.tenantId, tokenHash: { not: tokenHash }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audited('payment.webhook_token_rotated', config.id, {});
    return { token, urlPath: `/api/v1/payments/webhook/${token}` };
  }

  /**
   * Records that the inbound webhook URL was registered with Netpay.
   *
   * @param configId Configuration the URL belongs to.
   * @param url URL registered; only its host is audited, because the path holds
   *   the webhook token.
   */
  async markWebhookRegistered(configId: string, url: string): Promise<void> {
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentProviderConfig.update({
        where: { id: configId },
        // A new registration voids the last drift verdict until it is checked again.
        data: {
          webhookRegisteredAt: new Date(),
          webhookDrift: null,
          webhookDriftCheckedAt: null,
          updatedAt: new Date(),
        },
      }),
    );
    await this.audited('payment.webhook_registered', configId, { host: new URL(url).host });
  }

  /**
   * Records a configuration change in the audit log (BN-REQ-OPS-011). Never
   * carries a key or a token; never throws.
   *
   * @param action Dotted action name.
   * @param configId Configuration row.
   * @param metadata PII- and credential-free context.
   */
  private async audited(action: string, configId: string, metadata: Record<string, unknown>): Promise<void> {
    const context = this.requestContext.get();
    await this.audit.record({
      tenantId: context.tenant?.id ?? null,
      ...auditActorOf(context),
      action,
      resourceType: 'payment_config',
      resourceId: configId,
      metadata,
    });
  }

  /**
   * Resolves a tenant from an inbound webhook token.
   *
   * Deliberately independent of `X-Tenant-Id`: that header is caller-supplied
   * and the inbound notification is not signed, so it cannot be trusted to name
   * a tenant. The token identifies the tenant; the active version answers for it.
   *
   * @param token Opaque token from the webhook URL.
   * @returns The configuration, or `null` when no tenant matches.
   */
  async resolveByWebhookToken(
    token: string,
  ): Promise<(StoredPaymentConfig & { readonly schemaName: string }) | null> {
    const route = await this.controlPlane.client.paymentWebhookRegistry.findFirst({
      where: { tokenHash: PaymentSecretBox.hashToken(token), revokedAt: null },
      select: { schemaName: true },
    });
    if (route === null) {
      return null;
    }
    // Bound by the registry's schema rather than the request context: this runs
    // on a public route that never resolved a tenant.
    const row = await this.tenantPrisma.forTenantTransaction(route.schemaName, (client) =>
      client.paymentProviderConfig.findFirst(this.activeQuery()),
    );
    return row === null ? null : { ...toStored(row), schemaName: route.schemaName };
  }

  /**
   * Builds a fresh order reference for this tenant.
   *
   * @param prefix Configured prefix.
   * @returns A reference.
   */
  static newOrderReference(prefix: string): string {
    return buildOrderReference(prefix);
  }

  /**
   * The base URL for a tenant's environment.
   *
   * @param environment Sandbox or Live.
   * @returns Base URL.
   */
  static baseUrl(environment: NetpayEnvironment): string {
    return NETPAY_HOSTS[environment];
  }

  /**
   * Reads the optional configuration without throwing.
   *
   * @returns The configuration or `null`.
   */
  private async getOptional(): Promise<StoredPaymentConfig | null> {
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentProviderConfig.findFirst(this.activeQuery()),
    );
    return row === null ? null : toStored(row);
  }

  /**
   * Records the last drift check of the webhook Netpay has registered (BN-REQ-CFG-004).
   *
   * @param schemaName Tenant schema.
   * @param configId Version checked.
   * @param drift `true` drift, `false` match, `null` unknown.
   * @param checkedAt When it was checked.
   */
  async recordWebhookDrift(
    schemaName: string,
    configId: string,
    drift: boolean | null,
    checkedAt: Date,
  ): Promise<void> {
    await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentProviderConfig.update({
        where: { id: configId },
        data: { webhookDrift: drift, webhookDriftCheckedAt: checkedAt },
      }),
    );
  }

  /**
   * The query that reads the active version.
   *
   * @returns Prisma `findFirst` arguments.
   */
  private activeQuery(): {
    where: Prisma.PaymentProviderConfigWhereInput;
    orderBy: Prisma.PaymentProviderConfigOrderByWithRelationInput[];
    select: Prisma.PaymentProviderConfigSelect;
  } {
    return {
      where: { active: true },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
      select: this.configSelect(),
    };
  }

  /**
   * Column selection shared by every read.
   *
   * `secretKeyCiphertext` is included because the caller decrypts it; it is never
   * mapped into an HTTP response.
   *
   * @returns Prisma select.
   */
  private configSelect(): Prisma.PaymentProviderConfigSelect {
    return {
      id: true,
      tenantId: true,
      environment: true,
      publicKey: true,
      secretKeyCiphertext: true,
      orderReferencePrefix: true,
      enabled: true,
      version: true,
      allowedReturnOrigins: true,
      allowedCurrencies: true,
    };
  }
}

/**
 * Whether a version would change nothing.
 *
 * @param current The active version.
 * @param next The candidate (with the same secret already established).
 * @returns `true` when every setting is the same.
 */
function sameSettings(current: StoredPaymentConfig, next: VersionInput): boolean {
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  return (
    current.environment === next.environment &&
    current.publicKey === next.publicKey &&
    current.orderReferencePrefix === next.orderReferencePrefix &&
    same(current.allowedReturnOrigins, next.allowedReturnOrigins) &&
    same(current.allowedCurrencies, next.allowedCurrencies)
  );
}
