import { Controller, Get, Header, HttpCode, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  HealthService,
  readinessFor,
  type PublicReadinessReport,
  type ReadinessReport,
} from './health.service';

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
   *
   * The detailed report is only for authenticated callers. The endpoint has to
   * stay `@Public()` so the smoke test and any uptime check can reach it without
   * credentials, but with the service exposed to the internet a public 200 also
   * answers "there are two databases behind this, and here is how long each one
   * took" to anyone who asks. An anonymous caller gets the status and nothing
   * else; the status code still carries the signal an orchestrator needs.
   */
  @Public()
  @SkipThrottle()
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Verifies the control plane database is reachable. Responds 503 when it is not. The per-dependency detail is only returned to authenticated callers.',
  })
  @ApiResponse({ status: 200, description: 'All dependencies are reachable.' })
  @ApiResponse({ status: 503, description: 'At least one dependency is unavailable.' })
  async ready(@Req() request: Request): Promise<ReadinessReport | PublicReadinessReport> {
    const report = await this.health.readiness();

    // Both `authorization` and Cloud Run's own `X-Serverless-Authorization`
    // count: the latter is what carries the identity token of an authenticated
    // probe from CI, and Cloud Run gives it precedence. Reading only the former
    // would hide the report from the very client that pays for it.
    const authenticated = Boolean(
      request.headers.authorization || request.headers['x-serverless-authorization'],
    );

    return readinessFor(report, authenticated);
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
