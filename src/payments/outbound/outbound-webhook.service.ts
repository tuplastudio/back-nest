import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import { RequestContextService } from '../../tenancy/request-context.service';
import { PaymentSecretBox } from '../payment-secret-box';
import { ALL_PAYMENT_EVENTS } from '../payment-events';
import { UrlGuard } from './url-guard';
import { NotFoundException, ValidationException } from '../../common/errors/app.exception';
import { AuditLogService } from '../../audit/audit-log.service';
import { auditActorOf } from '../../audit/audit-actor';

/** An endpoint as exposed over the API. Never contains a secret. */
export interface WebhookEndpointView {
  readonly id: string;
  readonly url: string;
  readonly description: string | null;
  readonly events: string[];
  readonly status: string;
  readonly consecutiveFailures: number;
  readonly disabledReason: string | null;
  readonly createdAt: string;
}

/** Result of creating or rotating an endpoint secret. */
export interface WebhookSecretView extends WebhookEndpointView {
  /** Shown exactly once, like an API key secret. */
  readonly secret: string;
}

/**
 * Manages a tenant's outbound webhook endpoints.
 *
 * Writing an endpoint is a sensitive privilege and is deliberately not held by
 * `tenant-admin`: the destination is a channel through which tenant data leaves,
 * and it is also the SSRF surface described in {@link UrlGuard}.
 */
@Injectable()
export class OutboundWebhookService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly requestContext: RequestContextService,
    private readonly secretBox: PaymentSecretBox,
    private readonly urlGuard: UrlGuard,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Lists the tenant's endpoints.
   *
   * @returns The endpoints.
   */
  async list(): Promise<WebhookEndpointView[]> {
    const rows = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookEndpoint.findMany({
        where: { tenantId: this.currentTenantId() },
        orderBy: { createdAt: 'desc' },
        select: this.select(),
      }),
    );
    return rows.map((row) => this.toView(row));
  }

  /**
   * Creates an endpoint and returns its signing secret once.
   *
   * The URL is validated before it is stored, but it is validated again on every
   * delivery: a name that resolves privately today can resolve publicly tomorrow,
   * and the reverse is the case that matters.
   *
   * @param input Destination, description and subscribed events.
   * @returns The endpoint plus its secret.
   */
  async create(input: { url: string; description?: string; events: string[] }): Promise<WebhookSecretView> {
    if (input.events.length === 0) {
      throw new ValidationException('Subscribe to at least one event.');
    }
    const unknown = input.events.filter((event) => !ALL_PAYMENT_EVENTS.includes(event));
    if (unknown.length > 0) {
      throw new ValidationException(
        `Unknown event(s): ${unknown.join(', ')}. Known events: ${ALL_PAYMENT_EVENTS.join(', ')}.`,
      );
    }
    await this.urlGuard.validate(input.url);

    const tenantId = this.currentTenantId();
    const id = crypto.randomUUID();
    const secret = PaymentSecretBox.generateSigningSecret();
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookEndpoint.create({
        data: {
          id,
          tenantId,
          url: input.url,
          description: input.description ?? null,
          secretCiphertext: this.secretBox.encrypt(secret, PaymentSecretBox.aadForEndpoint(id)),
          events: input.events,
          updatedAt: new Date(),
        },
        select: this.select(),
      }),
    );
    await this.audited('webhook.endpoint_created', 'webhook_endpoint', id, {
      // The host only: a query string may carry the subscriber's own credential.
      host: new URL(input.url).host,
      events: input.events,
    });
    return { ...this.toView(row), secret };
  }

  /**
   * Rotates an endpoint's signing secret, keeping the previous one valid.
   *
   * The overlap is what lets a subscriber move to the new key without a window
   * where nothing is delivered; the old ciphertext is cleared by
   * {@link endRotation}.
   *
   * @param id Endpoint id.
   * @returns The endpoint plus its new secret.
   */
  async rotateSecret(id: string): Promise<WebhookSecretView> {
    const existing = await this.require(id);
    const secret = PaymentSecretBox.generateSigningSecret();
    const now = new Date();
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookEndpoint.update({
        where: { id: existing.id },
        data: {
          secretCiphertext: this.secretBox.encrypt(secret, PaymentSecretBox.aadForEndpoint(id)),
          previousSecretCiphertext: this.secretBox.encrypt(
            this.decrypt(existing.secretCiphertext, id),
            PaymentSecretBox.aadForEndpoint(id),
          ),
          consecutiveFailures: 0,
          status: 'ACTIVE',
          disabledAt: null,
          disabledReason: null,
          updatedAt: now,
        },
        select: this.select(),
      }),
    );
    await this.audited('webhook.endpoint_secret_rotated', 'webhook_endpoint', id, {});
    return { ...this.toView(row), secret };
  }

  /**
   * Ends a rotation overlap, making the previous secret unusable.
   *
   * @param id Endpoint id.
   */
  async endRotation(id: string): Promise<void> {
    await this.require(id);
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookEndpoint.update({
        where: { id },
        data: { previousSecretCiphertext: null, updatedAt: new Date() },
      }),
    );
    await this.audited('webhook.endpoint_rotation_ended', 'webhook_endpoint', id, {});
  }

  /**
   * Enables or disables an endpoint.
   *
   * @param id Endpoint id.
   * @param enabled Desired state.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.require(id);
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookEndpoint.update({
        where: { id },
        data: {
          status: enabled ? 'ACTIVE' : 'DISABLED',
          disabledAt: enabled ? null : new Date(),
          disabledReason: enabled ? null : 'Disabled by an operator.',
          updatedAt: new Date(),
        },
      }),
    );
    await this.audited(
      enabled ? 'webhook.endpoint_enabled' : 'webhook.endpoint_disabled',
      'webhook_endpoint',
      id,
      {
        to: enabled ? 'ACTIVE' : 'DISABLED',
      },
    );
  }

  /**
   * Lists recent deliveries, for diagnosing a subscriber.
   *
   * @param endpointId Endpoint to inspect.
   * @returns The deliveries.
   */
  async deliveries(endpointId: string): Promise<Record<string, unknown>[]> {
    await this.require(endpointId);
    return this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookDelivery.findMany({
        where: { endpointId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          eventId: true,
          eventType: true,
          attempt: true,
          status: true,
          responseStatus: true,
          durationMs: true,
          error: true,
          nextAttemptAt: true,
          deliveredAt: true,
          createdAt: true,
        },
      }),
    );
  }

  /**
   * Re-queues a delivery for another attempt (BN-REQ-EVT-010).
   *
   * The attempt counter is kept, not reset: the history of a delivery is what an
   * operator reads to decide whether the subscriber is fixed, and the next
   * `X-MTBPay-Attempt` must not claim a first try. The retry window restarts at
   * the replay (`replayedAt`) and the attempt cap counts only the attempts made
   * from now on (`attemptsBeforeReplay`), so a replay gets a full new window. Who
   * replayed it is recorded in the audit log.
   *
   * @param deliveryId Delivery to replay.
   */
  async replay(deliveryId: string): Promise<void> {
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookDelivery.findFirst({
        where: { id: deliveryId, endpoint: { tenantId: this.currentTenantId() } },
        select: {
          id: true,
          endpointId: true,
          eventId: true,
          eventType: true,
          orderId: true,
          status: true,
          attempt: true,
        },
      }),
    );
    if (row === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    const now = new Date();
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'PENDING',
          nextAttemptAt: now,
          error: null,
          replayedAt: now,
          // `attempt` is the number of the next attempt, so this many were made.
          attemptsBeforeReplay: Math.max(row.attempt - 1, 0),
        },
      }),
    );
    await this.audited('webhook.delivery_replayed', 'webhook_delivery', row.id, {
      endpointId: row.endpointId,
      eventId: row.eventId,
      eventType: row.eventType,
      orderId: row.orderId,
      from: row.status,
      to: 'PENDING',
      attempt: row.attempt,
    });
  }

  /**
   * Records a change to an endpoint or a delivery in the audit log
   * (BN-REQ-OPS-011). Never carries a secret; never throws.
   *
   * @param action Dotted action name.
   * @param resourceType `webhook_endpoint` or `webhook_delivery`.
   * @param resourceId Affected row.
   * @param metadata PII-free context.
   */
  private async audited(
    action: string,
    resourceType: 'webhook_endpoint' | 'webhook_delivery',
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const context = this.requestContext.get();
    await this.audit.record({
      tenantId: context.tenant?.id ?? null,
      ...auditActorOf(context),
      action,
      resourceType,
      resourceId,
      metadata,
    });
  }

  /**
   * Reads an endpoint the tenant owns.
   *
   * @param id Endpoint id.
   * @returns The endpoint row.
   * @throws {NotFoundException} When absent or owned by another tenant.
   */
  private async require(id: string): Promise<{ id: string; secretCiphertext: string }> {
    const row = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.webhookEndpoint.findFirst({
        where: { id, tenantId: this.currentTenantId() },
        select: { id: true, secretCiphertext: true },
      }),
    );
    if (row === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    return row;
  }

  /**
   * Decrypts an endpoint secret.
   *
   * @param ciphertext Stored ciphertext.
   * @param endpointId Endpoint it belongs to.
   * @returns The plaintext secret.
   */
  private decrypt(ciphertext: string, endpointId: string): string {
    return this.secretBox.decrypt(ciphertext, PaymentSecretBox.aadForEndpoint(endpointId));
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
  private select() {
    return {
      id: true,
      url: true,
      description: true,
      events: true,
      status: true,
      consecutiveFailures: true,
      disabledReason: true,
      createdAt: true,
    };
  }

  /**
   * Maps a row to the API view.
   *
   * @param row Selected row.
   * @returns The view.
   */
  private toView(row: {
    id: string;
    url: string;
    description: string | null;
    events: string[];
    status: string;
    consecutiveFailures: number;
    disabledReason: string | null;
    createdAt: Date;
  }): WebhookEndpointView {
    return {
      id: row.id,
      url: row.url,
      description: row.description,
      events: row.events,
      status: row.status,
      consecutiveFailures: row.consecutiveFailures,
      disabledReason: row.disabledReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
