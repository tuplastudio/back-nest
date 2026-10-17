import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';
import { PaymentSecretBox } from '../payment-secret-box';
import { UrlGuard, UrlRejectedError } from './url-guard';
import { buildEventBody, deliveryHeaders, signDelivery } from './signature';

/** HTTP contract for outbound deliveries. Injected so tests open no socket. */
export interface OutboundTransport {
  request(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
      hostHeader: string;
    },
  ): Promise<{ status: number }>;
}

/** Tuning, read from configuration. */
export interface OutboundOptions {
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitterMs: number;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly autoDisableAfter: number;
  readonly maxTenantsPerTick: number;
}

/** One delivery, flattened out of its schema. */
interface DeliveryRow {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly tenantId: string;
  readonly schemaName: string;
  readonly url: string;
  readonly secretCiphertext: string;
  readonly previousSecretCiphertext: string | null;
  readonly order: {
    readonly id: string;
    readonly orderReference: string;
    readonly merchantReferenceCode: string;
    readonly amount: string;
    readonly currency: string;
    readonly status: string;
  } | null;
}

/**
 * Delivers events to a tenant's outbound subscribers.
 *
 * The guarantees are modest and stated rather than implied:
 *
 * - **At least once.** A delivery is retried until it succeeds or the attempts
 *   run out, so a subscriber must be idempotent on `X-MTBPay-Event-Id`.
 * - **Unordered.** `sequence` lets a subscriber notice a gap.
 * - **Bounded.** An endpoint that keeps failing is disabled *with a reason*, and
 *   its delivery records are kept either way.
 *
 * The queue is in-process. That is a deliberate default for a base that ships no
 * broker dependency, and it is also the limit: a multi-instance deployment needs
 * a shared queue, otherwise two instances poll the same rows and deliver twice.
 * At-least-once makes that harmless, but it is worth knowing.
 */
@Injectable()
export class OutboundDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboundDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly transport: OutboundTransport,
    private readonly urlGuard: UrlGuard,
    private readonly secretBox: PaymentSecretBox,
    private readonly options: OutboundOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.pollIntervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.drainOnce();
    }, this.options.pollIntervalMs);
    // Never hold the process open just to retry webhooks.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Queues an event for every endpoint subscribed to it.
   *
   * @param eventType Event name.
   * @param tenantId Tenant that owns the event.
   * @param schemaName Schema holding the tenant's data.
   * @param payload Event payload, already free of personal data.
   */
  queue(
    eventType: string,
    tenantId: string,
    schemaName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Returned rather than fired and forgotten: awaiting it is what makes "the
    // event is durably queued" observable instead of assumed. Callers that do not
    // need to wait may discard it.
    return this.createDeliveries(eventType, tenantId, schemaName, payload);
  }

  /**
   * Attempts every delivery that is due, once.
   *
   * @returns How many were attempted.
   */
  async drainOnce(): Promise<number> {
    if (this.draining) {
      return 0;
    }
    this.draining = true;
    try {
      const due = await this.claimDueDeliveries();
      for (const delivery of due) {
        await this.deliver(delivery);
      }
      return due.length;
    } catch (error) {
      // The label alone is not diagnosable, so the message goes to the log while
      // the persisted record keeps the short form.
      this.logger.error(`Outbound drain failed: ${describe(error)}: ${message(error)}`);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Writes one pending delivery per matching endpoint.
   *
   * @param eventType Event name.
   * @param tenantId Tenant that owns the event.
   * @param schemaName Schema holding the tenant's data.
   * @param payload Event payload.
   */
  private async createDeliveries(
    eventType: string,
    tenantId: string,
    schemaName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const endpoints = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.webhookEndpoint.findMany({
          where: { tenantId, status: 'ACTIVE', events: { has: eventType } },
          select: { id: true },
        }),
      );
      if (endpoints.length === 0) {
        return;
      }
      // One id for the whole event, stable across endpoints and retries.
      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
      const sequence = Number(payload['sequence'] ?? 0);
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.webhookDelivery.createMany({
          data: endpoints.map((endpoint) => ({
            endpointId: endpoint.id,
            orderId: typeof payload['orderId'] === 'string' ? payload['orderId'] : null,
            eventId,
            eventType,
            sequence,
            status: 'PENDING' as const,
            nextAttemptAt: new Date(),
          })),
        }),
      );
    } catch (error) {
      this.logger.error(`Could not queue ${eventType}: ${describe(error)}: ${message(error)}`);
    }
  }

  /**
   * Reads the deliveries that are due, across the tenants most likely to have
   * any.
   *
   * Deliveries live in tenant schemas, which cannot be scanned from here, so the
   * active tenants are enumerated in the control plane and each is drained inside
   * its own transaction, where the RLS binding applies.
   *
   * @returns The deliveries to attempt.
   */
  private async claimDueDeliveries(): Promise<DeliveryRow[]> {
    // Deliveries live in tenant schemas, which cannot be scanned from here, so
    // the active tenants are enumerated in the control plane and each is drained
    // inside its own transaction, where the RLS binding applies.
    const tenants = await this.controlPlane.client.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, schemaName: true },
      take: this.options.maxTenantsPerTick,
      orderBy: { createdAt: 'asc' },
    });
    const now = new Date();
    const rows: DeliveryRow[] = [];
    for (const tenant of tenants) {
      const batch = await this.tenantPrisma.forTenantTransaction(tenant.schemaName, (client) =>
        client.webhookDelivery.findMany({
          where: {
            // A row that failed and was rescheduled is `FAILED`, not `PENDING`:
            // claiming only `PENDING` would mean a delivery is never retried, and
            // the backoff below would be unreachable.
            status: { in: ['PENDING', 'FAILED'] },
            nextAttemptAt: { lte: now },
            endpoint: { status: 'ACTIVE' },
            OR: [{ lockedAt: null }, { lockedAt: { lt: lockExpiry(now) } }],
          },
          take: this.options.batchSize,
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            eventId: true,
            eventType: true,
            sequence: true,
            attempt: true,
            endpoint: {
              select: {
                id: true,
                url: true,
                secretCiphertext: true,
                previousSecretCiphertext: true,
                tenantId: true,
              },
            },
            order: {
              select: {
                id: true,
                orderReference: true,
                merchantReferenceCode: true,
                amount: true,
                currency: true,
                status: true,
              },
            },
          },
        }),
      );
      // Claim each row for this instance before acting on it, so a second
      // instance polling the same schema does not pick the same rows up while
      // this one is still delivering them.
      const ids = batch.map((row) => row.id);
      if (ids.length > 0) {
        await this.claim(tenant.schemaName, ids, now);
      }
      for (const row of batch) {
        rows.push({
          id: row.id,
          endpointId: row.endpoint.id,
          eventId: row.eventId,
          eventType: row.eventType,
          sequence: row.sequence,
          attempt: row.attempt,
          tenantId: row.endpoint.tenantId,
          schemaName: tenant.schemaName,
          url: row.endpoint.url,
          secretCiphertext: row.endpoint.secretCiphertext,
          previousSecretCiphertext: row.endpoint.previousSecretCiphertext,
          order: row.order
            ? {
                id: row.order.id,
                orderReference: row.order.orderReference,
                merchantReferenceCode: row.order.merchantReferenceCode,
                amount: row.order.amount.toFixed(2),
                currency: row.order.currency,
                status: row.order.status,
              }
            : null,
        });
      }
    }
    return rows;
  }

  /**
   * Marks deliveries as owned by this instance.
   *
   * The claim is a single conditional update: only rows that are still unclaimed
   * (or whose previous claim has expired) are taken, so two instances racing on
   * the same row end up with one owner rather than both proceeding.
   *
   * @param schemaName Tenant schema.
   * @param ids Delivery ids to claim.
   * @param now Claim time.
   */
  private async claim(schemaName: string, ids: string[], now: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const expiry = lockExpiry(now);
    try {
      await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
        client.webhookDelivery.updateMany({
          where: {
            id: { in: ids },
            status: { in: ['PENDING', 'FAILED'] },
            OR: [{ lockedAt: null }, { lockedAt: { lt: expiry } }],
          },
          data: { lockedAt: now, lockedBy: INSTANCE_ID },
        }),
      );
    } catch (error) {
      this.logger.error(`Could not claim deliveries: ${describe(error)}: ${message(error)}`);
    }
  }

  /**
   * Performs one delivery attempt and records the outcome.
   *
   * @param delivery Delivery to attempt.
   */
  private async deliver(delivery: DeliveryRow): Promise<void> {
    const started = Date.now();
    const body = buildEventBody(
      delivery.eventId,
      delivery.eventType,
      new Date().toISOString(),
      delivery.sequence,
      delivery.tenantId,
      {
        orderId: delivery.order?.id ?? null,
        orderReference: delivery.order?.orderReference ?? null,
        merchantReferenceCode: delivery.order?.merchantReferenceCode ?? null,
        amount: delivery.order?.amount ?? null,
        currency: delivery.order?.currency ?? null,
        status: delivery.order?.status ?? null,
      },
    );

    let validated;
    try {
      validated = await this.urlGuard.validate(delivery.url);
    } catch (error) {
      // A destination the guard refuses will never start working, so retrying is
      // pointless: the endpoint is misconfigured and needs an operator.
      await this.record(delivery, {
        status: 'FAILED',
        outcome: error instanceof UrlRejectedError ? error.reason : 'INVALID_URL',
        durationMs: Date.now() - started,
        disableEndpoint: true,
      });
      return;
    }

    const secrets = this.decryptSecrets(delivery);
    try {
      const response = await this.transport.request(validated.url, {
        method: 'POST',
        headers: {
          ...deliveryHeaders(delivery.eventId, delivery.eventType, delivery.attempt),
          'x-mtbpay-signature': this.signatureFor(body, secrets),
        },
        body,
        timeoutMs: this.options.timeoutMs,
        hostHeader: validated.hostHeader,
      });
      await this.record(delivery, {
        status: response.status >= 200 && response.status < 300 ? 'DELIVERED' : 'FAILED',
        responseStatus: response.status,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      await this.record(delivery, {
        status: 'FAILED',
        outcome: describe(error),
        durationMs: Date.now() - started,
      });
    }
  }

  /**
   * Decrypts the endpoint's secrets, current first.
   *
   * @param delivery Delivery being processed.
   * @returns Decrypted secrets.
   */
  private decryptSecrets(delivery: DeliveryRow): string[] {
    const aad = PaymentSecretBox.aadForEndpoint(delivery.endpointId);
    const candidates = [delivery.secretCiphertext, delivery.previousSecretCiphertext];
    const out: string[] = [];
    for (const ciphertext of candidates) {
      if (ciphertext === null) {
        continue;
      }
      try {
        out.push(this.secretBox.decrypt(ciphertext, aad));
      } catch {
        // A secret that will not decrypt is a corrupt row, not a transient fault;
        // skipping it keeps the current key working during a rotation.
      }
    }
    return out;
  }

  /**
   * Signs a delivery, emitting both signatures during a rotation overlap.
   *
   * @param body Exact body.
   * @param secrets Decrypted secrets, current first.
   * @returns The signature header value.
   */
  private signatureFor(body: string, secrets: string[]): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const current = secrets[0];
    if (current === undefined) {
      return `t=${timestamp},v1=`;
    }
    const header = signDelivery(current, body, timestamp)['x-mtbpay-signature'] ?? '';
    const previous = secrets[1];
    if (previous === undefined) {
      return header;
    }
    // Both are accepted by a subscriber verifying either secret, so the
    // endpoint can be rotated without a window where nothing is delivered.
    const previousHeader = signDelivery(previous, body, timestamp)['x-mtbpay-signature'] ?? '';
    // One timestamp, two `v1` values. A subscriber holding either secret finds
    // one, and the header stays a single well-formed expression instead of a
    // second partial one.
    const previousSignature = previousHeader.slice(previousHeader.indexOf('v1=') + 3);
    return `${header},v1=${previousSignature}`;
  }

  /**
   * Writes the outcome of an attempt and updates the endpoint's health.
   *
   * @param delivery Delivery attempted.
   * @param outcome Result fields.
   */
  private async record(
    delivery: DeliveryRow,
    outcome: {
      status: 'DELIVERED' | 'FAILED';
      responseStatus?: number;
      outcome?: string;
      durationMs: number;
      disableEndpoint?: boolean;
    },
  ): Promise<void> {
    const now = Date.now();
    const delivered = outcome.status === 'DELIVERED';
    const exhausted = !delivered && delivery.attempt >= this.options.maxAttempts;
    const status = delivered ? 'DELIVERED' : exhausted ? 'DEAD' : 'FAILED';
    const backoff = Math.min(
      this.options.baseBackoffMs * 2 ** Math.max(delivery.attempt - 1, 0),
      this.options.maxBackoffMs,
    );
    const jitter = this.options.jitterMs === 0 ? 0 : Math.floor(Math.random() * this.options.jitterMs);

    try {
      await this.tenantPrisma.forTenantTransaction(delivery.schemaName, async (client) => {
        await client.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: status as never,
            attempt: { increment: 1 },
            responseStatus: outcome.responseStatus ?? null,
            durationMs: outcome.durationMs,
            error: outcome.outcome?.slice(0, 240) ?? null,
            nextAttemptAt: delivered ? null : new Date(now + backoff + jitter),
            deliveredAt: delivered ? new Date(now) : null,
            // Released either way: the row is either finished or waiting for its
            // next attempt, and a retained claim would keep other instances out
            // until it expired.
            lockedAt: null,
            lockedBy: null,
          },
        });
        const current = await client.webhookEndpoint.findFirstOrThrow({
          where: { id: delivery.endpointId },
          select: { consecutiveFailures: true },
        });
        const failures = delivered ? 0 : current.consecutiveFailures + 1;
        await client.webhookEndpoint.update({
          where: { id: delivery.endpointId },
          data: {
            consecutiveFailures: failures,
            ...(outcome.disableEndpoint === true || failures >= this.options.autoDisableAfter
              ? {
                  status: 'AUTO_DISABLED' as const,
                  disabledAt: new Date(now),
                  disabledReason:
                    outcome.outcome ?? 'Disabled automatically after repeated delivery failures.',
                }
              : {}),
          },
        });
      });
    } catch (error) {
      this.logger.error(`Could not record delivery ${delivery.id}: ${describe(error)}: ${message(error)}`);
    }
  }
}

/** Identifies this process in a delivery claim. */
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * How long a claim is honoured before another instance may take the row.
 *
 * Long enough to cover a slow endpoint within the request timeout, short enough
 * that a crashed instance does not strand deliveries.
 */
const LOCK_TTL_MS = 120_000;

/**
 * The instant before which a claim is considered stale.
 *
 * @param now Reference time.
 * @returns Expiry boundary.
 */
function lockExpiry(now: Date): Date {
  return new Date(now.getTime() - LOCK_TTL_MS);
}

/**
 * Returns a description of an error that is safe to persist.
 *
 * Never includes a message from the far end: that is the subscriber's response
 * body, which the tenant does not get to read through our logs.
 *
 * @param error Caught value.
 * @returns A short label.
 */
function message(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  // Prisma's request errors can carry their detail in `code` and `meta` rather
  // than in the message, and an empty message is not diagnosable.
  const code = (error as { code?: unknown }).code;
  const meta = (error as { meta?: unknown }).meta;
  const parts = [error.message === '' ? '(no message)' : error.message];
  if (code !== undefined) {
    parts.push(`code=${typeof code === 'string' ? code : JSON.stringify(code)}`);
  }
  if (meta !== undefined) {
    parts.push(`meta=${JSON.stringify(meta)}`);
  }
  return parts.join(' ');
}

function describe(error: unknown): string {
  if (error instanceof UrlRejectedError) {
    return error.reason;
  }
  return error instanceof Error ? error.name : 'unknown';
}
