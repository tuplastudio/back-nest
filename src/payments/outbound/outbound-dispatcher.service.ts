import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-plane/client';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';
import { quoteIdentifier } from '../../prisma/identifiers';
import { PaymentSecretBox } from '../payment-secret-box';
import { eventIdFor, serializeEventPayload, type PaymentEventPayload } from '../payment-events';
import { logOutboundDelivery } from '../../common/logging/payment-log-events';
import { UrlGuard, UrlRejectedError, type ValidatedUrl } from './url-guard';
import { buildEventBody, deliveryHeaders, signDelivery } from './signature';

/** Where a delivery goes: the subscribed URL and the validated addresses it may use. */
export type OutboundDestination = Pick<ValidatedUrl, 'url' | 'addresses'>;

/**
 * HTTP contract for outbound deliveries. Injected so tests open no socket.
 *
 * The implementation connects only to `destination.addresses`, in order, and
 * never resolves the hostname itself.
 */
export interface OutboundTransport {
  request(
    destination: OutboundDestination,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    },
  ): Promise<{ status: number }>;
}

/** Tuning, read from configuration. */
export interface OutboundOptions {
  /** Safety cap on attempts. The retry window ({@link maxAgeMs}) normally ends a delivery first. */
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  /** Longest wait between two attempts. */
  readonly maxBackoffMs: number;
  readonly jitterMs: number;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  /** Deliveries claimed per tenant and cycle. */
  readonly batchSize: number;
  /** Consecutive failures an endpoint needs, on top of a failed retry window, to be disabled. */
  readonly autoDisableAfter: number;
  /** Tenants read per control-plane query while enumerating; every active tenant is visited each cycle. */
  readonly maxTenantsPerTick: number;
  /** How long a delivery is retried before it is DEAD (`OUTBOUND_WEBHOOK_MAX_AGE_HOURS`). */
  readonly maxAgeMs: number;
  /** Deliveries in flight at once (`OUTBOUND_WEBHOOK_CONCURRENCY`). */
  readonly concurrency: number;
}

/**
 * Growth factor between two retry delays. With a 1 s base it gives 1 s, 5 s,
 * 25 s, ~2 min, ~10 min, ~52 min, then the cap: close to the documented
 * 1 s, 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 1 h… schedule.
 */
const BACKOFF_FACTOR = 5;

/** Share of a delay that jitter may take off, so retries spread out without ever exceeding the cap. */
const JITTER_RATIO = 0.2;

/**
 * Delay before the next attempt: capped exponential backoff with jitter.
 *
 * The jitter only ever shortens the wait (by up to {@link JITTER_RATIO} of the
 * step, and at least `jitterMs`), so the cap is a hard ceiling: after any number
 * of failures the next attempt is at most `maxBackoffMs` away.
 *
 * @param attempt The attempt that just failed, starting at 1.
 * @param tuning Base, cap and minimum jitter.
 * @param random Source of randomness in [0, 1). Injected for tests.
 * @returns Milliseconds to wait.
 */
export function retryDelayMs(
  attempt: number,
  tuning: Pick<OutboundOptions, 'baseBackoffMs' | 'maxBackoffMs' | 'jitterMs'>,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 32);
  const step = Math.min(tuning.baseBackoffMs * BACKOFF_FACTOR ** exponent, tuning.maxBackoffMs);
  const spread = Math.min(Math.max(step * JITTER_RATIO, tuning.jitterMs), step);
  return Math.max(0, Math.round(step - random() * spread));
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
  readonly createdAt: Date;
  /** Last operator replay; the retry window restarts here (BN-REQ-EVT-010). */
  readonly replayedAt: Date | null;
  /** Attempts made before the last replay. */
  readonly attemptsBeforeReplay: number;
  /** Persisted event snapshot, delivered verbatim. Null for pre-outbox deliveries. */
  readonly snapshot: PaymentEventPayload | null;
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

/** A pending outbox event, as the fan-out reads it. */
interface PendingEvent {
  readonly id: string;
  readonly orderId: string;
  readonly sequence: number;
  readonly eventType: string;
}

/**
 * Delivers events to a tenant's outbound subscribers.
 *
 * Events come from the transactional outbox (`payment_event_outbox`), written in
 * the same transaction as the order change. Each cycle first fans pending
 * events out to one delivery per subscribed endpoint, then attempts the due
 * deliveries. A delivery sends the persisted snapshot, never a rebuild from the
 * order's current row (BN-REQ-EVT-005).
 *
 * The guarantees are modest and stated rather than implied:
 *
 * - **At least once.** A delivery is retried, with capped exponential backoff
 *   and jitter, for the whole retry window (24 h by default) before it is DEAD,
 *   so a subscriber must be idempotent on `X-MTBPay-Event-Id`.
 * - **Unordered.** `sequence` lets a subscriber notice a gap.
 * - **Fair.** Every cycle visits every active tenant, interleaves their due
 *   deliveries round-robin and runs them with bounded concurrency, capping how
 *   many slots one endpoint can hold. A slow subscriber delays itself, not
 *   everyone else.
 * - **Patient.** A failure to resolve or validate the destination at delivery
 *   time is retried like any other failure. An endpoint is disabled, *with a
 *   reason*, only when it has failed continuously for the whole retry window;
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
  /** Tenant the next cycle starts from, so no tenant is always served first. */
  private tenantCursor = 0;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly transport: OutboundTransport,
    private readonly urlGuard: UrlGuard,
    private readonly secretBox: PaymentSecretBox,
    private readonly options: OutboundOptions,
    private readonly now: () => number = Date.now,
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
      await this.deliverAll(due);
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
   * Fans pending outbox events out to the endpoints subscribed to them.
   *
   * One transaction per tenant: the pending events are locked with
   * `FOR UPDATE SKIP LOCKED`, so two replicas never fan out the same event (the
   * second skips the rows the first holds), one delivery per subscribed endpoint
   * is inserted (`ON CONFLICT DO NOTHING` on `(eventId, endpointId)`), and the
   * events are marked dispatched. A crash anywhere in between rolls all of it
   * back, and the next cycle (on any instance) starts over.
   *
   * An event nobody subscribes to is marked dispatched too: subscriptions are
   * not retroactive.
   *
   * @param schemaName Tenant schema.
   * @param now Fan-out time; deliveries are due at once.
   * @returns How many events were fanned out.
   */
  private async fanOut(schemaName: string, now: Date): Promise<number> {
    const table = Prisma.raw(`${quoteIdentifier(schemaName)}."payment_event_outbox"`);
    return this.tenantPrisma.forTenantTransaction(schemaName, async (client) => {
      const pending = await client.$queryRaw<PendingEvent[]>(
        Prisma.sql`SELECT "id", "orderId", "sequence", "eventType" FROM ${table}
          WHERE "dispatchedAt" IS NULL
          ORDER BY "occurredAt" ASC
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED`,
      );
      if (pending.length === 0) {
        return 0;
      }
      const endpoints = await client.webhookEndpoint.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, events: true },
      });
      const rows = pending.flatMap((event) =>
        endpoints
          .filter((endpoint) => endpoint.events.includes(event.eventType))
          .map((endpoint) => ({
            endpointId: endpoint.id,
            orderId: event.orderId,
            outboxId: event.id,
            eventId: eventIdFor(event.id),
            eventType: event.eventType,
            sequence: event.sequence,
            status: 'PENDING' as const,
            nextAttemptAt: now,
          })),
      );
      if (rows.length > 0) {
        await client.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
      }
      await client.paymentEventOutbox.updateMany({
        where: { id: { in: pending.map((event) => event.id) } },
        data: { dispatchedAt: now },
      });
      return pending.length;
    });
  }

  /**
   * Claims the deliveries that are due, across every active tenant, in a fair
   * order.
   *
   * Deliveries live in tenant schemas, which cannot be scanned from here, so the
   * active tenants are enumerated in the control plane (in pages) and each is
   * read inside its own transaction, where the RLS binding applies. Each tenant
   * contributes at most `batchSize` rows, and the result is interleaved
   * round-robin starting from a tenant that rotates every cycle, so a tenant
   * with a large backlog cannot crowd the others out.
   *
   * @returns The deliveries to attempt, in the order they should start.
   */
  private async claimDueDeliveries(): Promise<DeliveryRow[]> {
    const tenants = await this.activeTenants();
    if (tenants.length === 0) {
      return [];
    }
    const start = this.tenantCursor % tenants.length;
    this.tenantCursor = (start + 1) % tenants.length;
    const ordered = [...tenants.slice(start), ...tenants.slice(0, start)];

    const now = new Date(this.now());
    const perTenant: DeliveryRow[][] = [];
    for (const tenant of ordered) {
      try {
        perTenant.push(await this.claimForTenant(tenant.schemaName, now));
      } catch (error) {
        // One tenant whose schema cannot be read must not stop the others.
        this.logger.error(`Could not read deliveries: ${describe(error)}: ${message(error)}`);
      }
    }
    return interleave(perTenant);
  }

  /**
   * Lists every active tenant, a page at a time.
   *
   * @returns The tenants, in a stable order.
   */
  private async activeTenants(): Promise<{ id: string; schemaName: string }[]> {
    const page = Math.max(this.options.maxTenantsPerTick, 1);
    const out: { id: string; schemaName: string }[] = [];
    let after: string | null = null;
    for (;;) {
      const batch: { id: string; schemaName: string }[] = await this.controlPlane.client.tenant.findMany({
        where: { status: 'ACTIVE', ...(after === null ? {} : { id: { gt: after } }) },
        select: { id: true, schemaName: true },
        take: page,
        orderBy: { id: 'asc' },
      });
      out.push(...batch);
      if (batch.length < page) {
        return out;
      }
      after = batch[batch.length - 1].id;
    }
  }

  /**
   * Reads and claims one tenant's due deliveries.
   *
   * @param schemaName Tenant schema.
   * @param now Claim time.
   * @returns The claimed rows, oldest first.
   */
  private async claimForTenant(schemaName: string, now: Date): Promise<DeliveryRow[]> {
    try {
      await this.fanOut(schemaName, now);
    } catch (error) {
      // The events stay pending and the next cycle retries; deliveries already
      // fanned out are still attempted below.
      this.logger.error(`Could not fan out events: ${describe(error)}: ${message(error)}`);
    }
    const batch = await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
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
          createdAt: true,
          replayedAt: true,
          attemptsBeforeReplay: true,
          outbox: { select: { payload: true } },
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
    await this.claim(
      schemaName,
      batch.map((row) => row.id),
      now,
    );
    return batch.map((row) => ({
      id: row.id,
      endpointId: row.endpoint.id,
      eventId: row.eventId,
      eventType: row.eventType,
      sequence: row.sequence,
      attempt: row.attempt,
      tenantId: row.endpoint.tenantId,
      schemaName,
      url: row.endpoint.url,
      createdAt: row.createdAt,
      replayedAt: row.replayedAt,
      attemptsBeforeReplay: row.attemptsBeforeReplay,
      snapshot: (row.outbox?.payload ?? null) as PaymentEventPayload | null,
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
    }));
  }

  /**
   * Runs deliveries with bounded concurrency.
   *
   * At most `concurrency` attempts are in flight, and at most a quarter of them
   * (at least one) for the same endpoint, so an endpoint that takes the full
   * timeout to answer occupies a few slots while every other subscriber keeps
   * moving through the rest. Rows wait in the given (fair) order and a free slot
   * takes the first one whose endpoint is not saturated.
   *
   * The cycle also has a time budget (the longer of the request timeout and the
   * poll interval). Rows still waiting when it runs out, typically the backlog
   * of one slow endpoint, are released for a later cycle instead of holding
   * this one open, so the next cycle can serve every other tenant on time.
   *
   * @param queue Deliveries in the order they should start.
   */
  private async deliverAll(queue: DeliveryRow[]): Promise<void> {
    const concurrency = Math.max(this.options.concurrency, 1);
    const perEndpoint = Math.max(1, Math.floor(concurrency / 4));
    const deadline = this.now() + Math.max(this.options.timeoutMs, this.options.pollIntervalMs);
    const waiting = [...queue];
    const inFlight = new Map<string, number>();
    const running = new Set<Promise<void>>();

    while (waiting.length > 0 || running.size > 0) {
      if (waiting.length > 0 && this.now() >= deadline) {
        await this.release(waiting.splice(0));
      }
      while (running.size < concurrency) {
        const index = waiting.findIndex((row) => (inFlight.get(row.endpointId) ?? 0) < perEndpoint);
        if (index === -1) {
          break;
        }
        const [delivery] = waiting.splice(index, 1);
        inFlight.set(delivery.endpointId, (inFlight.get(delivery.endpointId) ?? 0) + 1);
        const task: Promise<void> = this.deliver(delivery)
          .catch((error: unknown) => {
            this.logger.error(`Delivery ${delivery.id} failed: ${describe(error)}: ${message(error)}`);
          })
          .finally(() => {
            inFlight.set(delivery.endpointId, (inFlight.get(delivery.endpointId) ?? 1) - 1);
            running.delete(task);
          });
        running.add(task);
      }
      if (running.size === 0) {
        return;
      }
      await Promise.race(running);
    }
  }

  /**
   * Gives back claims on rows this cycle did not get to, so the next cycle (on
   * this instance or another) picks them up without waiting for the claim to
   * expire.
   *
   * @param rows Claimed rows that were not attempted.
   */
  private async release(rows: DeliveryRow[]): Promise<void> {
    const bySchema = new Map<string, string[]>();
    for (const row of rows) {
      bySchema.set(row.schemaName, [...(bySchema.get(row.schemaName) ?? []), row.id]);
    }
    for (const [schemaName, ids] of bySchema) {
      try {
        await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
          client.webhookDelivery.updateMany({
            where: { id: { in: ids }, lockedBy: INSTANCE_ID },
            data: { lockedAt: null, lockedBy: null },
          }),
        );
      } catch (error) {
        // The claim expires on its own; this only makes the hand-back faster.
        this.logger.warn(`Could not release deliveries: ${describe(error)}: ${message(error)}`);
      }
    }
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
    const body =
      delivery.snapshot !== null
        ? // The event as it was when the order changed (BN-REQ-EVT-005).
          serializeEventPayload(delivery.snapshot)
        : // Queued before the outbox existed: the previous, rebuilt body.
          buildEventBody(
            delivery.eventId,
            delivery.eventType,
            new Date(this.now()).toISOString(),
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
      // Re-checked on every delivery, so this is where a DNS outage or a record
      // that briefly points somewhere private shows up. Both are usually
      // transient: retry like any other failure and leave disabling to the
      // 24 h rule in `record`. The guard still never lets a request out.
      await this.record(delivery, {
        status: 'FAILED',
        outcome: error instanceof UrlRejectedError ? error.reason : 'INVALID_URL',
        durationMs: Date.now() - started,
      });
      return;
    }

    const secrets = this.decryptSecrets(delivery);
    try {
      const response = await this.transport.request(
        { url: validated.url, addresses: validated.addresses },
        {
          method: 'POST',
          headers: {
            ...deliveryHeaders(delivery.eventId, delivery.eventType, delivery.attempt),
            'x-mtbpay-signature': this.signatureFor(body, secrets),
          },
          body,
          timeoutMs: this.options.timeoutMs,
        },
      );
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
   * A failed delivery is rescheduled until it is older than the retry window
   * (or, as a safety net, out of attempts), and only then DEAD. For a replayed
   * delivery both are measured from the replay: the window from `replayedAt`,
   * the attempts from those made since (BN-REQ-EVT-010). The endpoint is
   * disabled only when such a delivery died without the endpoint accepting
   * anything since that delivery was created, and after at least
   * `autoDisableAfter` consecutive failures: in other words, when it has been
   * failing continuously for the whole window.
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
    },
  ): Promise<void> {
    const now = this.now();
    const delivered = outcome.status === 'DELIVERED';
    const windowStart = delivery.replayedAt ?? delivery.createdAt;
    const agedOut = now - windowStart.getTime() >= this.options.maxAgeMs;
    // `attempt` is the number of the attempt just made.
    const attemptsInWindow = delivery.attempt - delivery.attemptsBeforeReplay;
    const exhausted = !delivered && (agedOut || attemptsInWindow >= this.options.maxAttempts);
    const status = delivered ? 'DELIVERED' : exhausted ? 'DEAD' : 'FAILED';
    const nextAttemptAt =
      delivered || exhausted ? null : new Date(now + retryDelayMs(delivery.attempt, this.options));

    try {
      const disabled = await this.tenantPrisma.forTenantTransaction(delivery.schemaName, async (client) => {
        await client.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: status as never,
            attempt: { increment: 1 },
            responseStatus: outcome.responseStatus ?? null,
            durationMs: outcome.durationMs,
            error: outcome.outcome?.slice(0, 240) ?? null,
            nextAttemptAt,
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
        let disable = false;
        if (exhausted && agedOut && failures >= this.options.autoDisableAfter) {
          // Any success since this delivery was created means the endpoint
          // worked during the window: the failure was not continuous.
          const recentSuccess = await client.webhookDelivery.findFirst({
            where: {
              endpointId: delivery.endpointId,
              status: 'DELIVERED',
              deliveredAt: { gte: windowStart },
            },
            select: { id: true },
          });
          disable = recentSuccess === null;
        }
        await client.webhookEndpoint.update({
          where: { id: delivery.endpointId },
          data: {
            consecutiveFailures: failures,
            ...(disable
              ? {
                  status: 'AUTO_DISABLED' as const,
                  disabledAt: new Date(now),
                  disabledReason:
                    `Failing continuously for ${Math.round(this.options.maxAgeMs / 3_600_000)} h (last error: ${
                      outcome.outcome ?? `HTTP ${outcome.responseStatus ?? 'n/a'}`
                    }).`.slice(0, 240),
                }
              : {}),
          },
        });
        return disable;
      });
      logOutboundDelivery(this.logger, {
        deliveryId: delivery.id,
        result: delivered ? 'delivered' : disabled ? 'disabled' : exhausted ? 'failed' : 'retry',
        attempt: delivery.attempt,
        ...(outcome.responseStatus === undefined ? {} : { httpStatus: outcome.responseStatus }),
        latencyMs: outcome.durationMs,
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
 * Merges per-tenant queues round-robin: the first row of each tenant, then the
 * second of each, and so on.
 *
 * @param queues One queue per tenant, in visiting order.
 * @returns A single fair queue.
 */
function interleave<T>(queues: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = queues.reduce((max, queue) => Math.max(max, queue.length), 0);
  for (let i = 0; i < longest; i += 1) {
    for (const queue of queues) {
      if (i < queue.length) {
        out.push(queue[i]);
      }
    }
  }
  return out;
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
