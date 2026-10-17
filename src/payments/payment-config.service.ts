import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { PaymentSecretBox, buildOrderReference } from './payment-secret-box';
import { NETPAY_HOSTS, type NetpayEnvironment } from './netpay-endpoints';
import type { Prisma } from '../generated/tenant-plane/client';
import { NotFoundException, ValidationException } from '../common/errors/app.exception';

/** A tenant's stored provider configuration, with the secret still encrypted. */
export interface StoredPaymentConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly environment: NetpayEnvironment;
  readonly publicKey: string;
  readonly secretKeyCiphertext: string;
  readonly orderReferencePrefix: string;
  readonly enabled: boolean;
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
      client.paymentProviderConfig.findFirst({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          tenantId: true,
          environment: true,
          publicKey: true,
          secretKeyCiphertext: true,
          orderReferencePrefix: true,
          enabled: true,
        },
      }),
    );
    if (row === null) {
      throw new NotFoundException('This tenant has no payment provider configured.');
    }
    return { ...row, environment: row.environment };
  }

  /**
   * Reads the configuration and decrypts the secret, refusing a disabled tenant.
   *
   * @returns Configuration plus the plaintext secret.
   * @throws {ValidationException} When payments are disabled for the tenant.
   */
  async getUsable(): Promise<StoredPaymentConfig & { readonly secretKey: string }> {
    return this.getUsableInSchema(this.tenantPrisma.requireCurrentSchema());
  }

  /**
   * Reads a tenant's configuration from outside its request context.
   *
   * @param schemaName Schema holding the configuration.
   * @returns Configuration plus the plaintext secret.
   * @throws {ValidationException} When payments are disabled for the tenant.
   */
  async getUsableInSchema(schemaName: string): Promise<StoredPaymentConfig & { readonly secretKey: string }> {
    const config = await this.getUsableFrom(schemaName);
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
   * Reads the newest configuration in a given schema.
   *
   * @param schemaName Schema to read.
   * @returns The configuration.
   */
  private async getUsableFrom(schemaName: string): Promise<StoredPaymentConfig> {
    const row = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentProviderConfig.findFirst({
        orderBy: { createdAt: 'desc' },
        select: this.configSelect(),
      }),
    );
    if (row === null) {
      throw new NotFoundException('This tenant has no payment provider configured.');
    }
    return { ...row, environment: row.environment };
  }

  /**
   * Stores the tenant's configuration, replacing any previous one.
   *
   * @param input Keys and settings.
   * @returns The stored configuration.
   */
  async save(input: {
    publicKey: string;
    secretKey: string;
    environment: NetpayEnvironment;
    orderReferencePrefix?: string;
  }): Promise<{ config: StoredPaymentConfig; webhookToken: string | null }> {
    if (!input.publicKey.startsWith('pk_netpay_')) {
      throw new ValidationException('The Netpay public key must start with pk_netpay_.');
    }
    if (!input.secretKey.startsWith('sk_netpay_')) {
      throw new ValidationException('The Netpay secret key must start with sk_netpay_.');
    }
    const tenantId = this.currentTenantId();
    const existing = await this.getOptional();
    const prefix = input.orderReferencePrefix ?? existing?.orderReferencePrefix ?? tenantId.slice(0, 8);
    const secretKeyCiphertext = this.secretBox.encrypt(
      input.secretKey,
      PaymentSecretBox.aadForConfig(tenantId),
    );
    const now = new Date();
    // A first configuration mints the inbound webhook token here. It is returned
    // once and registered below, because the token is the only thing that can
    // resolve an unsigned notification to this tenant: a hash that nobody
    // registers would leave the webhook permanently unroutable.
    const webhookToken = existing === null ? PaymentSecretBox.generateToken() : null;
    const record = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      existing === null
        ? client.paymentProviderConfig.create({
            data: {
              tenantId,
              environment: input.environment as never,
              publicKey: input.publicKey,
              secretKeyCiphertext,
              orderReferencePrefix: prefix,
              webhookTokenHash: PaymentSecretBox.hashToken(webhookToken as string),
              createdAt: now,
              updatedAt: now,
            },
            select: this.configSelect(),
          })
        : client.paymentProviderConfig.update({
            where: { id: existing.id },
            data: {
              environment: input.environment as never,
              publicKey: input.publicKey,
              secretKeyCiphertext,
              orderReferencePrefix: prefix,
              updatedAt: now,
            },
            select: this.configSelect(),
          }),
    );
    const config: StoredPaymentConfig = {
      ...record,
      environment: record.environment,
    };
    if (webhookToken !== null) {
      await this.registerWebhookToken(webhookToken, config);
    }
    return { config, webhookToken };
  }

  /**
   * Registers a token in the control-plane routing table.
   *
   * @param token Opaque token.
   * @param config Configuration the token belongs to.
   */
  private async registerWebhookToken(token: string, config: StoredPaymentConfig): Promise<void> {
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    await this.controlPlane.client.paymentWebhookRegistry.upsert({
      where: { tokenHash: PaymentSecretBox.hashToken(token) },
      update: { environment: config.environment as never, revokedAt: null, schemaName },
      create: {
        tenantId: config.tenantId,
        schemaName,
        tokenHash: PaymentSecretBox.hashToken(token),
        environment: config.environment as never,
      },
    });
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
        data: { webhookTokenHash: tokenHash, updatedAt: new Date() },
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
    return { token, urlPath: `/api/v1/payments/webhook/${token}` };
  }

  /**
   * Resolves a tenant from an inbound webhook token.
   *
   * Deliberately independent of `X-Tenant-Id`: that header is caller-supplied
   * and the inbound notification is not signed, so it cannot be trusted to name
   * a tenant. Each tenant has one configuration, so the token identifies the
   * tenant and its own row.
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
      client.paymentProviderConfig.findFirst({
        orderBy: { createdAt: 'desc' },
        select: this.configSelect(),
      }),
    );
    return row === null ? null : { ...row, schemaName: route.schemaName, environment: row.environment };
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
      client.paymentProviderConfig.findFirst({
        orderBy: { createdAt: 'desc' },
        select: this.configSelect(),
      }),
    );
    return row === null ? null : { ...row, environment: row.environment };
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
    };
  }
}
