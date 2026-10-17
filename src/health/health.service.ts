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
 * Implements the health checks behind {@link HealthController}.
 *
 * Kept separate from the controller so the checks can be exercised directly in
 * unit tests without spinning up HTTP.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  /**
   * @param controlPlane Control-plane Prisma service.
   * @param tenantPlane Tenant Prisma service.
   * @param version Application version, injected by the module.
   */
  constructor(
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly tenantPlane: TenantPrismaService,
    private readonly version: string,
  ) {}

  /**
   * Liveness check. Intentionally does not touch the database.
   *
   * @returns A minimal payload proving the event loop is responsive.
   */
  liveness(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness check with per-dependency timing.
   *
   * @returns A report whose `status` is `degraded` when any check failed.
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
   * Runs a probe and records how long it took.
   *
   * @param probe The operation to time.
   * @returns A status record with latency and, on failure, a safe message.
   */
  private async time(
    probe: () => Promise<void>,
  ): Promise<{ status: 'up' | 'down'; latencyMs: number; message?: string }> {
    const startedAt = Date.now();
    try {
      await probe();
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      // The detail goes to the log, never to the body: these probes are public
      // and unthrottled, and a driver message can name the host, the database,
      // the schema and the failing statement.
      const detail = (error as Error).message;
      this.logger.warn(`Health check failed: ${detail}`);
      return { status: 'down', latencyMs: Date.now() - startedAt, message: 'probe failed' };
    }
  }
}
