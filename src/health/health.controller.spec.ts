import 'reflect-metadata';
import { jest } from '@jest/globals';
import type { Request } from 'express';
import type { HealthService, ReadinessReport } from './health.service';
import type { HealthController as HealthControllerType } from './health.controller';

// `@nestjs/throttler` ships CommonJS that requires the ESM-only `@nestjs/common`,
// which this ESM test runtime cannot load; its decorators are irrelevant here.
const noopDecorator = () => () => undefined;
jest.unstable_mockModule('@nestjs/throttler', () => ({
  SkipThrottle: noopDecorator,
  Throttle: noopDecorator,
}));
let HealthController: typeof HealthControllerType;
beforeAll(async () => {
  ({ HealthController } = await import('./health.controller.js'));
});

/**
 * What `/health/ready` hands to whom (BN-TASK-037, BN-REQ-SEC-009, BN-REQ-OPS-010).
 *
 * The global AuthGuard runs on this public route too: it verifies whatever
 * bearer token arrives and attaches `request.principal` only when the token is
 * real. The controller must decide on that principal, never on the header.
 */
const REPORT: ReadinessReport = {
  status: 'degraded',
  reasons: ['outboundDisabled'],
  uptimeSeconds: 10,
  timestamp: '2026-10-21T00:00:00.000Z',
  version: '1.4.2',
  build: { version: '1.4.2', sha: '0123456789abcdef0123456789abcdef01234567' },
  checks: {
    'control-plane-db': { status: 'up', latencyMs: 2 },
    'outbound-webhooks': { status: 'down', message: 'disabled while ACTIVE endpoints exist' },
  },
};

function controller(): HealthControllerType {
  const health = { readiness: () => Promise.resolve(REPORT) } as unknown as HealthService;
  return new HealthController(health);
}

function request(fields: Record<string, unknown>): Request {
  return { headers: {}, ...fields } as unknown as Request;
}

describe('HealthController.ready', () => {
  it('gives a forged Authorization header nothing but the verdict', async () => {
    const body = await controller().ready(request({ headers: { authorization: 'Bearer not.a.real.token' } }));
    expect(body).toEqual({ status: 'degraded', timestamp: REPORT.timestamp });
  });

  it('gives an anonymous probe nothing but the verdict', async () => {
    const body = await controller().ready(request({}));
    expect(Object.keys(body).sort()).toEqual(['status', 'timestamp']);
  });

  it('gives a verified principal the detail, the cause, and the build version and SHA', async () => {
    const body = (await controller().ready(
      request({ principal: { kind: 'platform-admin', id: 'admin-1' } }),
    )) as ReadinessReport;
    expect(body.reasons).toEqual(['outboundDisabled']);
    expect(body.build).toEqual({ version: '1.4.2', sha: '0123456789abcdef0123456789abcdef01234567' });
    expect(body.checks['outbound-webhooks']?.status).toBe('down');
  });

  it('redirects the bare path to the API reference', () => {
    const redirect = jest.fn();
    controller().redirectToDocs({ redirect } as never);
    expect(redirect).toHaveBeenCalledWith('/docs');
  });

  it('answers liveness without touching the readiness probe', () => {
    const health = {
      liveness: () => ({ status: 'ok', uptimeSeconds: 1, timestamp: 't' }),
    } as unknown as HealthService;
    expect(new HealthController(health).live()).toEqual({ status: 'ok', uptimeSeconds: 1, timestamp: 't' });
  });
});
