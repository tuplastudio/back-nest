import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-plane/client';
import { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import { quoteIdentifier } from '../../prisma/identifiers';
import { PaymentOrdersService } from '../payment-orders.service';
import {
  logReconcileChecked,
  logReconcileCorrected,
  logReconcileErrors,
} from '../../common/logging/payment-log-events';

/** Tuning, from `RECONCILE_*` (see `src/config/env.validation.ts`). */
export interface ReconcileOptions {
  /** `RECONCILE_ENABLED`: the in-process timer. `/internal/tick` works either way. */
  readonly enabled: boolean;
  /** Time between passes of the in-process timer; 0 turns the timer off. */
  readonly intervalMs: number;
  /** Orders untouched for less than this are not picked up. */
  readonly minAgeMs: number;
  /** Orders leased per tenant and pass. */
  readonly batchSize: number;
  /** How long an order picked by one worker is invisible to the others. */
  readonly leaseMs: number;
  /** WAIT_THREEDS for longer than this: EXPIRED (BN-REQ-REC-002). */
  readonly threeDsTimeoutMs: number;
  /** CHARGE_UNKNOWN with no transaction for longer than this: back to PENDING. */
  readonly chargeUnknownGraceMs: number;
  /** Calls to Netpay per second and tenant (BN-REQ-REC-004). */
  readonly providerRatePerSecond: number;
  /** CANCELLED / EXPIRED orders changed within this window are re-checked for a late payment. */
  readonly lateWindowMs: number;
}

/** What one pass did. `skipped` when another pass was still running in this instance. */
export interface ReconcileSummary {
  readonly tenants: number;
  readonly checked: number;
  readonly corrected: number;
  readonly errors: number;
  readonly pendingApplied: number;
  readonly skipped?: true;
}

/** A clock that can wait, injected so the rate limiter is testable. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Optional per-tenant check run once in a while by the pass (the webhook drift check). */
export interface TenantCheck {
  checkIfDue(tenant: { readonly id: string; readonly schemaName: string }, now: Date): Promise<void>;
}

/**
 * Spaces calls so that at most `ratePerSecond` start in any second.
 *
 * One limiter per tenant and pass: Netpay rate-limits per key set, and each tenant
 * has its own.
 */
export class ProviderRateLimiter {
  private next = 0;
  private readonly gapMs: number;

  constructor(
    ratePerSecond: number,
    private readonly clock: Clock = REAL_CLOCK,
  ) {
    this.gapMs = Math.ceil(1000 / Math.max(ratePerSecond, 1));
  }

  /** Waits until the next call may start. */
  async acquire(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) {
      await this.clock.sleep(at - now);
    }
  }
}

/** Statuses a pass looks at, besides the late-payment check. */
const SQL_ACTIVE = Prisma.sql`('PENDING', 'PENDING_VERIFICATION')`;
const SQL_REFUNDABLE = Prisma.sql`('PAID', 'PARTIALLY_REFUNDED')`;
const SQL_TERMINAL_UNPAID = Prisma.sql`('CANCELLED', 'EXPIRED')`;

/**
 * Reconciles non-terminal orders with Netpay (BN-REQ-REC-001…004).
 *
 * One pass, for every ACTIVE tenant:
 *
 *  1. applies the provider results waiting in `pending_provider_result`
 *     (BN-REQ-IDM-004);
 *  2. leases up to `batchSize` candidate orders untouched for `minAgeMs`: PENDING or
 *     PENDING_VERIFICATION with a transaction or an expired cash reference,
 *     CHARGE_UNKNOWN, PAID/PARTIALLY_REFUNDED holding a `refund` claim, and
 *     CANCELLED/EXPIRED with a transaction and no late payment recorded yet;
 *  3. reconciles each with {@link PaymentOrdersService.reconcileOrder}, at most
 *     `providerRatePerSecond` Netpay calls per second;
 *  4. logs `reconcile_checked`, `reconcile_corrected` and `reconcile_errors`, the
 *     events the log-based metrics count.
 *
 * Safe with several instances: the lease is taken with `FOR UPDATE SKIP LOCKED`
 * plus `reconcileLeaseUntil` in one short transaction, so a second worker skips
 * the rows the first one holds while it leases them and sees the lease after. The
 * Netpay call happens outside any transaction; every write is guarded by the
 * status read under the row lock.
 *
 * Triggered two ways. The in-process timer runs every `intervalMs` (with jitter)
 * while the instance lives, which with min-instances 0 means while there is
 * traffic. `POST /internal/tick` runs one pass on demand: Cloud Scheduler calls it
 * every 15 min in staging (scripts/gcp/scheduler-internal-tick.sh); production has
 * no scheduler by owner decision (docs/RUNBOOK-PAYMENTS.md §1.2).
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly orders: PaymentOrdersService,
    private readonly options: ReconcileOptions,
    private readonly tenantCheck: TenantCheck | null = null,
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.options.intervalMs <= 0) {
      return;
    }
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Schedules the next pass: one interval plus up to 20 % jitter, so instances
   * started together do not all ask Netpay at once. Never at boot: a cold start
   * serves its request first.
   */
  private schedule(): void {
    const delay = this.options.intervalMs + Math.floor(Math.random() * this.options.intervalMs * 0.2);
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (!this.stopped) {
          this.schedule();
        }
      });
    }, delay);
    // Never hold the process open just to reconcile.
    this.timer.unref();
  }

  /**
   * Runs one pass over every active tenant.
   *
   * @returns What it did; `skipped` when a pass is already running in this instance.
   */
  async runOnce(): Promise<ReconcileSummary> {
    if (this.running) {
      return { tenants: 0, checked: 0, corrected: 0, errors: 0, pendingApplied: 0, skipped: true };
    }
    this.running = true;
    const totals = { tenants: 0, checked: 0, corrected: 0, errors: 0, pendingApplied: 0 };
    try {
      const tenants = await this.activeTenants();
      for (const tenant of tenants) {
        totals.tenants += 1;
        const result = await this.reconcileTenant(tenant);
        totals.checked += result.checked;
        totals.corrected += result.corrected;
        totals.errors += result.errors;
        totals.pendingApplied += result.pendingApplied;
      }
      return totals;
    } catch (error) {
      this.logger.error(`Reconciliation pass failed: ${(error as Error).name}: ${(error as Error).message}`);
      return totals;
    } finally {
      this.running = false;
    }
  }

  /**
   * One tenant's share of a pass. Never throws: a tenant that fails is counted
   * and the pass goes on with the next one.
   *
   * @param tenant Tenant and schema.
   * @returns Counts.
   */
  private async reconcileTenant(tenant: {
    readonly id: string;
    readonly schemaName: string;
  }): Promise<{ checked: number; corrected: number; errors: number; pendingApplied: number }> {
    const counts = { checked: 0, corrected: 0, errors: 0, pendingApplied: 0 };
    try {
      const pending = await this.orders.applyPendingProviderResults(tenant);
      counts.pendingApplied = pending.applied;
      counts.errors += pending.failed;
    } catch (error) {
      counts.errors += 1;
      this.logger.error(`Pending provider results could not be applied: ${(error as Error).name}`);
    }
    let candidates: string[] = [];
    try {
      candidates = await this.lease(tenant.schemaName, new Date(this.clock.now()));
    } catch (error) {
      counts.errors += 1;
      this.logger.error(
        `Could not lease orders to reconcile: ${(error as Error).name}: ${(error as Error).message}`,
      );
    }
    const limiter = new ProviderRateLimiter(this.options.providerRatePerSecond, this.clock);
    for (const orderId of candidates) {
      counts.checked += 1;
      try {
        const outcome = await this.orders.reconcileOrder(tenant, orderId, {
          now: new Date(this.clock.now()),
          beforeProviderCall: () => limiter.acquire(),
          threeDsTimeoutMs: this.options.threeDsTimeoutMs,
          chargeUnknownGraceMs: this.options.chargeUnknownGraceMs,
          referenceGraceMs: this.options.minAgeMs,
        });
        if (outcome.corrected) {
          counts.corrected += 1;
          logReconcileCorrected(this.logger, {
            tenantId: tenant.id,
            orderId,
            from: outcome.from,
            to: outcome.to,
            action: outcome.action,
          });
        }
      } catch (error) {
        counts.errors += 1;
        this.logger.warn(`Could not reconcile order ${orderId}: ${(error as Error).name}`);
      }
    }
    if (this.tenantCheck !== null) {
      await this.tenantCheck.checkIfDue(tenant, new Date(this.clock.now())).catch((error: unknown) => {
        this.logger.warn(`Tenant check failed: ${(error as Error).name}`);
      });
    }
    logReconcileChecked(this.logger, { tenantId: tenant.id, count: counts.checked });
    if (counts.errors > 0) {
      logReconcileErrors(this.logger, { tenantId: tenant.id, count: counts.errors });
    }
    return counts;
  }

  /**
   * Leases this pass's candidate orders in one short transaction.
   *
   * `FOR UPDATE SKIP LOCKED` keeps a concurrent worker off the rows while they are
   * being leased; `reconcileLeaseUntil` keeps it off them afterwards. Raw SQL on
   * purpose: a Prisma update would move `updatedAt`, which is both the age this
   * selection reads and the watermark consumers list by.
   *
   * @param schemaName Tenant schema.
   * @param now Pass time.
   * @returns Leased order ids, oldest change first.
   */
  private async lease(schemaName: string, now: Date): Promise<string[]> {
    const table = Prisma.raw(`${quoteIdentifier(schemaName)}."payment_orders"`);
    const at = now.toISOString();
    const cutoff = new Date(now.getTime() - this.options.minAgeMs).toISOString();
    const lateFrom = new Date(now.getTime() - this.options.lateWindowMs).toISOString();
    const until = new Date(now.getTime() + this.options.leaseMs).toISOString();
    return this.tenantPrisma.forTenantTransaction(schemaName, async (client) => {
      const rows = await client.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id"::text AS "id" FROM ${table}
          WHERE ("reconcileLeaseUntil" IS NULL OR "reconcileLeaseUntil" < ${at}::timestamp(3))
            AND "updatedAt" < ${cutoff}::timestamp(3)
            AND (
              ("status"::text IN ${SQL_ACTIVE}
                AND ("netpayTransactionId" IS NOT NULL OR "paymentReferenceExpiresAt" < ${at}::timestamp(3)))
              OR "status"::text = 'CHARGE_UNKNOWN'
              OR ("status"::text IN ${SQL_REFUNDABLE} AND "operationClaim" = 'refund')
              OR ("status"::text IN ${SQL_TERMINAL_UNPAID}
                AND "netpayTransactionId" IS NOT NULL
                AND "paidAfterCancelAt" IS NULL
                AND "updatedAt" > ${lateFrom}::timestamp(3))
            )
          ORDER BY "updatedAt" ASC
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length === 0) {
        return [];
      }
      const ids = rows.map((row) => row.id);
      await client.$executeRaw(
        Prisma.sql`UPDATE ${table} SET "reconcileLeaseUntil" = ${until}::timestamp(3)
          WHERE "id"::text IN (${Prisma.join(ids)})`,
      );
      return ids;
    });
  }

  /**
   * Every active tenant, in pages.
   *
   * @returns Tenants in a stable order.
   */
  private async activeTenants(): Promise<{ id: string; schemaName: string }[]> {
    const page = 200;
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
}
