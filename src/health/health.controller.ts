import { Controller, Get, Header, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { HealthService } from './health.service';

/**
 * Response body returned by the readiness probe.
 */
interface HealthReport {
  /** `ok` when every dependency is reachable, otherwise `degraded`. */
  status: 'ok' | 'degraded';
  /** Uptime in seconds since process start. */
  uptimeSeconds: number;
  /** ISO timestamp of the check. */
  timestamp: string;
  /** Application version from `package.json`. */
  version: string;
  /** Per-dependency state. */
  checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; message?: string }>;
}

/**
 * Liveness and readiness endpoints.
 *
 * Both are `@Public()` and rate-limit exempt so an orchestrator can poll them
 * without credentials and without being throttled.
 *
 * Distinguishing the two matters operationally: `/health/live` answers "is the
 * process alive" and must never touch the database, otherwise a brief database
 * outage triggers a restart storm that makes the outage worse. `/health/ready`
 * answers "can this instance serve traffic" and therefore does check the
 * database.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  /**
   * @param health Health check service.
   */
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness probe. Returns 200 as long as the event loop is responsive.
   */
  @Public()
  @SkipThrottle()
  @Get('live')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe', description: 'Returns 200 while the process is responsive.' })
  @ApiResponse({ status: 200, description: 'The process is alive.' })
  @ApiResponse({ status: 503, description: 'The process is shutting down.' })
  @ApiExcludeEndpoint(false)
  live(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return this.health.liveness();
  }

  /**
   * Readiness probe. Verifies the control-plane database connection.
   *
   * Responds 503 when a dependency is unavailable so a load balancer stops
   * routing traffic to this instance.
   */
  @Public()
  @SkipThrottle()
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Verifies the control plane database is reachable. Responds 503 when it is not.',
  })
  @ApiResponse({ status: 200, description: 'All dependencies are reachable.' })
  @ApiResponse({ status: 503, description: 'At least one dependency is unavailable.' })
  async ready(): Promise<HealthReport> {
    return this.health.readiness();
  }

  /**
   * Redirects to the Scalar API reference.
   *
   * Convenience for humans; the OpenAPI document itself is served at
   * `/{docsPath}/openapi.json`.
   */
  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: 'API reference', description: 'Redirects to the interactive API documentation.' })
  redirectToDocs(@Res() response: Response): void {
    response.redirect('/docs');
  }
}
