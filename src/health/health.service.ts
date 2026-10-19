import { Injectable, Logger } from '@nestjs/common';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';

/**
 * Readiness probe data returned to the orchestrator.
 */
export interface ReadinessReport {
  /** Aggregate status. */
  status: 'ok' | 'degraded';
  /** Process uptime in seconds. */
  uptimeSeconds: number;
  /** ISO timestamp of the check. */
  timestamp: string;
  /** Application version. */
  version: string;
  /** Per-dependency status. */
  checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; message?: string }>;
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
  authenticated: boolean,
): ReadinessReport | PublicReadinessReport {
  if (authenticated) return report;
  return { status: report.status, timestamp: report.timestamp };
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
  private readonly startedAt = Date.now();

  constructor(
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly tenantPlane: TenantPrismaService,
    private readonly version: string,
  ) {}

  /**
   * Liveness: the process is responsive. Never touches the database, so a
   * database outage cannot turn into a restart storm.
   */
  liveness(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: both database planes answer. Degraded if either fails.
   */
  async readiness(): Promise<ReadinessReport> {
    const checks: ReadinessReport['checks'] = {};

    const controlPlane = await this.time(async () => {
      await this.controlPlane.client.$queryRaw`SELECT 1`;
    });
    checks['control-plane-db'] = controlPlane;

    const tenantPlane = await this.time(async () => {
      await this.tenantPlane.probe();
    });
    checks['tenant-plane'] = tenantPlane;

    const degraded = Object.values(checks).some((check) => check.status === 'down');

    return {
      status: degraded ? 'degraded' : 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      version: this.version,
      checks,
    };
  }

  /**
   * Runs one probe and reports how long it took, without leaking the error.
   */
  private async time(
    probe: () => Promise<void>,
  ): Promise<{ status: 'up' | 'down'; latencyMs?: number; message?: string }> {
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
