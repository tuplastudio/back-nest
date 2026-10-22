import { Injectable, Logger } from '@nestjs/common';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { BuildInfo } from '../config/build-info';
import type { DriftSummary } from '../payments/webhook-drift.service';

export type { BuildInfo } from '../config/build-info';

/** One dependency's state in the readiness report. */
export interface ReadinessCheck {
  status: 'up' | 'down';
  latencyMs?: number;
  message?: string;
}

/**
 * Readiness probe data returned to a verified principal.
 */
export interface ReadinessReport {
  /** Aggregate status. */
  status: 'ok' | 'degraded';
  /**
   * Why the status is `degraded`: the failing check names, plus
   * `outboundDisabled` when deliveries are off while ACTIVE endpoints exist.
   * Empty when `ok`.
   */
  reasons: string[];
  /** Process uptime in seconds. */
  uptimeSeconds: number;
  /** ISO timestamp of the check. */
  timestamp: string;
  /** Application version. Same as `build.version`, kept for existing readers. */
  version: string;
  /** Build version and commit SHA (BN-REQ-OPS-010). */
  build: BuildInfo;
  /** Per-dependency status. */
  checks: Record<string, ReadinessCheck>;
  /**
   * Whether Netpay notifies this deployment (BN-REQ-CFG-004), from the stored
   * verdicts of the drift checks; never a call to Netpay. Reported and alerted on
   * (`netpay_webhook_drift`), but it does not make the instance `degraded`: a
   * drifted registration is fixed at Netpay, not by taking this instance out.
   */
  netpayWebhookDrift?: DriftSummary | { status: 'unknown'; message: string };
}

/**
 * Readiness probe data an anonymous caller is allowed to see.
 *
 * The readiness route is public so that CI and uptime checks can reach it
 * without credentials, which also means anyone on the internet can ask. The
 * full report names both databases and their latency: reconnaissance, with no
 * operational value, because the status code already carries the verdict.
 */
export interface PublicReadinessReport {
  /** Aggregate status. */
  status: 'ok' | 'degraded';
  /** ISO timestamp of the check. */
  timestamp: string;
}

/** Construction options for {@link HealthService}. */
export interface HealthOptions extends BuildInfo {
  /** `OUTBOUND_WEBHOOK_ENABLED`. */
  outboundEnabled: boolean;
  /** How long a readiness result is reused. Defaults to {@link READINESS_CACHE_MS}. */
  cacheTtlMs?: number;
  /** Clock, injected for tests. */
  now?: () => number;
  /** Source of the webhook drift summary; omitted where payments are not wired. */
  webhookDrift?: { summary(): Promise<DriftSummary> };
}

/**
 * How long one readiness result is served before the dependencies are probed
 * again (BN-REQ-SEC-009). The route is public and unthrottled, so without it
 * every anonymous request would cost two database round trips.
 */
export const READINESS_CACHE_MS = 5_000;

/**
 * Narrows a readiness report to what the caller may see.
 *
 * Pure on purpose, and that is the point: "who sees what" is policy, not
 * plumbing, so it lives where it can be exercised without booting Nest —and
 * without the controller's decorators, which pull `@nestjs/throttler` into the
 * module graph.
 */
export function readinessFor(
  report: ReadinessReport,
  verified: boolean,
): ReadinessReport | PublicReadinessReport {
  if (verified) return report;
  return { status: report.status, timestamp: report.timestamp };
}

/**
 * Whether the request carries a principal the authentication guard verified.
 *
 * The global `AuthGuard` also runs on public routes: it verifies any bearer
 * token presented (API key against its hash, JWT against its signature and
 * the account's current state) and attaches `request.principal` only when that
 * succeeds. A header on its own proves nothing (anyone can send
 * `Authorization: Bearer x`), so this reads the principal, never the header.
 *
 * @param request The incoming request, after guards have run.
 * @returns `true` only for a verified principal.
 */
export function hasVerifiedPrincipal(request: { principal?: unknown; headers?: unknown }): boolean {
  return request.principal !== undefined && request.principal !== null;
}

/**
 * Implements the health checks behind {@link HealthController}.
 *
 * Kept separate from the controller so the checks can be exercised directly in
 * unit tests without spinning up HTTP.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt: number;
  private readonly now: () => number;
  private cached: { at: number; report: Promise<ReadinessReport> } | null = null;

  constructor(
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly tenantPlane: TenantPrismaService,
    private readonly options: HealthOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /**
   * Liveness: the process is responsive. Never touches the database, so a
   * database outage cannot turn into a restart storm.
   */
  liveness(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((this.now() - this.startedAt) / 1000),
      timestamp: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Readiness: both database planes answer, and deliveries are not switched off
   * under tenants that expect them. Degraded otherwise, with the reasons.
   *
   * Served from a short cache, and concurrent callers share one probe.
   */
  readiness(): Promise<ReadinessReport> {
    const now = this.now();
    const ttl = this.options.cacheTtlMs ?? READINESS_CACHE_MS;
    if (this.cached !== null && now - this.cached.at < ttl) {
      return this.cached.report;
    }
    const report = this.probe();
    this.cached = { at: now, report };
    // A probe that throws must not stay cached as a rejection.
    report.catch(() => {
      this.cached = null;
    });
    return report;
  }

  /** Runs every check once. */
  private async probe(): Promise<ReadinessReport> {
    const checks: ReadinessReport['checks'] = {};

    checks['control-plane-db'] = await this.time(async () => {
      await this.controlPlane.client.$queryRaw`SELECT 1`;
    });
    checks['tenant-plane'] = await this.time(async () => {
      await this.tenantPlane.probe();
    });

    const reasons = Object.entries(checks)
      .filter(([, check]) => check.status === 'down')
      .map(([name]) => name);

    // Only worth asking when deliveries are off and the databases answer.
    if (this.options.outboundEnabled) {
      checks['outbound-webhooks'] = { status: 'up' };
    } else if (reasons.length === 0) {
      const subscribed = await this.anyActiveEndpoint();
      if (subscribed) {
        checks['outbound-webhooks'] = {
          status: 'down',
          message: 'OUTBOUND_WEBHOOK_ENABLED=false while ACTIVE endpoints exist',
        };
        reasons.push('outboundDisabled');
      } else {
        checks['outbound-webhooks'] = { status: 'up', message: 'disabled, no ACTIVE endpoints' };
      }
    }

    let netpayWebhookDrift: ReadinessReport['netpayWebhookDrift'];
    if (this.options.webhookDrift !== undefined) {
      try {
        netpayWebhookDrift = await this.options.webhookDrift.summary();
      } catch (error) {
        this.logger.warn(`Webhook drift summary unavailable: ${(error as Error).name}`);
        netpayWebhookDrift = { status: 'unknown', message: 'drift summary unavailable' };
      }
    }

    return {
      status: reasons.length > 0 ? 'degraded' : 'ok',
      reasons,
      uptimeSeconds: Math.floor((this.now() - this.startedAt) / 1000),
      timestamp: new Date(this.now()).toISOString(),
      version: this.options.version,
      build: { version: this.options.version, sha: this.options.sha },
      checks,
      ...(netpayWebhookDrift === undefined ? {} : { netpayWebhookDrift }),
    };
  }

  /**
   * Whether any active tenant has an ACTIVE outbound endpoint. Stops at the
   * first one found; a schema that cannot be read is skipped, not fatal.
   */
  private async anyActiveEndpoint(): Promise<boolean> {
    const tenants = await this.controlPlane.client.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { schemaName: true },
    });
    for (const tenant of tenants) {
      try {
        const count = await this.tenantPlane.forTenantTransaction(tenant.schemaName, (client) =>
          client.webhookEndpoint.count({ where: { status: 'ACTIVE' } }),
        );
        if (count > 0) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Could not count outbound endpoints: ${(error as Error).name}`);
      }
    }
    return false;
  }

  /**
   * Runs one probe and reports how long it took, without leaking the error.
   */
  private async time(probe: () => Promise<void>): Promise<ReadinessCheck> {
    const startedAt = Date.now();
    try {
      await probe();
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.logger.warn(`Health probe failed: ${(error as Error).message}`);
      return { status: 'down', latencyMs: Date.now() - startedAt, message: 'probe failed' };
    }
  }
}
