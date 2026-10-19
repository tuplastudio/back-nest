import 'reflect-metadata';
import { jest } from '@jest/globals';
import { HealthService, isAuthenticatedRequest, readinessFor, type ReadinessReport } from './health.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';

function serviceFor(controlPlaneError: Error | null, tenantPlaneError: Error | null) {
  const controlPlane = {
    client: {
      $queryRaw: jest.fn(() => {
        if (controlPlaneError) throw controlPlaneError;
        return [{ '?column?': 1 }];
      }),
    },
  } as unknown as ControlPlanePrismaService;

  const tenantPlane = {
    probe: jest.fn(() => {
      if (tenantPlaneError) throw tenantPlaneError;
    }),
  } as unknown as TenantPrismaService;

  return new HealthService(controlPlane, tenantPlane, '1.0.0');
}

describe('HealthService.readiness', () => {
  it('reports ok when both planes answer', async () => {
    const report = await serviceFor(null, null).readiness();
    expect(report.status).toBe('ok');
    expect(report.checks['control-plane-db']?.status).toBe('up');
    expect(report.checks['tenant-plane']?.status).toBe('up');
  });

  it('really probes the tenant plane instead of assuming it is up', async () => {
    // The check used to be a no-op that always resolved. If it regresses to one,
    // a broken data plane would be reported as healthy.
    const service = serviceFor(null, new Error('tenant plane unreachable'));
    const report = await service.readiness();
    expect(report.checks['tenant-plane']?.status).toBe('down');
    expect(report.status).toBe('degraded');
  });

  it('marks the report degraded when the control plane is down', async () => {
    const report = await serviceFor(new Error('control plane unreachable'), null).readiness();
    expect(report.status).toBe('degraded');
    expect(report.checks['control-plane-db']?.status).toBe('down');
  });

  it('does not leak the dependency error into the public body', async () => {
    // This endpoint is public and unthrottled; a driver message names the host,
    // the database, the schema and the failing statement.
    const leaky = new Error(
      'connect ECONNREFUSED 10.1.2.3:5432: database "mtb_prod" user "mtb_control" password authentication failed for tenant_acme_45fd71af',
    );
    const report = await serviceFor(leaky, null).readiness();

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('ECONNREFUSED');
    expect(serialised).not.toContain('mtb_prod');
    expect(serialised).not.toContain('mtb_control');
    expect(serialised).not.toContain('tenant_acme');
    expect(report.checks['control-plane-db']?.message).toBe('probe failed');
  });

  it('truncates nothing user-visible but still reports a latency', async () => {
    const report = await serviceFor(null, null).readiness();
    expect(typeof report.checks['control-plane-db']?.latencyMs).toBe('number');
    expect(report.version).toBe('1.0.0');
  });
});

describe('readinessFor', () => {
  const report: ReadinessReport = {
    status: 'ok',
    uptimeSeconds: 42,
    timestamp: '2026-10-18T00:00:00.000Z',
    version: '1.0.0',
    checks: {
      'control-plane-db': { status: 'up', latencyMs: 21 },
      'tenant-plane': { status: 'up', latencyMs: 22 },
    },
  };

  it('trims the report for an anonymous caller', () => {
    // The route is public, so anyone can ask. Handing out both database names
    // and their latency is reconnaissance with no operational gain: the status
    // code already carries what a health check needs.
    expect(readinessFor(report, false)).toEqual({
      status: 'ok',
      timestamp: report.timestamp,
    });
  });

  it('keeps the detail for a caller that presented a credential', () => {
    expect(readinessFor(report, true)).toEqual(report);
  });

  it('still reports degraded to an anonymous caller', () => {
    // Trimming the body must not soften the verdict: a 503 with `degraded` is
    // what makes a load balancer stop routing here.
    expect(readinessFor({ ...report, status: 'degraded' }, false)).toEqual({
      status: 'degraded',
      timestamp: report.timestamp,
    });
  });

  it('does not leak dependency names or latencies when trimmed', () => {
    // The assertion that matters: the trimmed body has exactly these two keys,
    // so there is nothing left to enumerate. Checking the keys beats checking
    // three absences, which would still pass if a fourth field appeared.
    const trimmed = readinessFor(report, false);

    expect(Object.keys(trimmed).sort()).toEqual(['status', 'timestamp']);
  });
});

describe('isAuthenticatedRequest', () => {
  it('accepts a bearer token', () => {
    expect(isAuthenticatedRequest({ authorization: 'Bearer mtb_live_abc_123' })).toBe(true);
  });

  it('accepts the header Cloud Run gives precedence to', () => {
    // The identity token of CI's smoke arrives here and nowhere else: Cloud Run
    // reads X-Serverless-Authorization first, so `authorization` is empty on that
    // request. Ignoring this header would classify our own smoke as anonymous
    // and hide the report from it.
    expect(isAuthenticatedRequest({ 'x-serverless-authorization': 'Bearer eyJhbGciOi' })).toBe(true);
  });

  it('rejects an anonymous probe', () => {
    expect(isAuthenticatedRequest({})).toBe(false);
    expect(isAuthenticatedRequest({ 'user-agent': 'curl/8.7.1' })).toBe(false);
  });
});
