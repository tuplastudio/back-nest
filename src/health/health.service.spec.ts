import 'reflect-metadata';
import { jest } from '@jest/globals';
import {
  HealthService,
  hasVerifiedPrincipal,
  readinessFor,
  type HealthOptions,
  type ReadinessReport,
} from './health.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';

const BUILD = { version: '1.4.2', sha: '0123456789abcdef0123456789abcdef01234567' };

function harness(
  controlPlaneError: Error | null,
  tenantPlaneError: Error | null,
  options: Partial<HealthOptions> & { activeEndpointsBySchema?: Record<string, number> } = {},
) {
  const clock = { now: 1_000_000 };
  const activeEndpointsBySchema = options.activeEndpointsBySchema ?? {};
  const queryRaw = jest.fn(() => {
    if (controlPlaneError) throw controlPlaneError;
    return [{ '?column?': 1 }];
  });
  const controlPlane = {
    client: {
      $queryRaw: queryRaw,
      tenant: {
        findMany: jest.fn(() =>
          Promise.resolve(
            Object.keys(activeEndpointsBySchema).map((schemaName, i) => ({ id: `t${i}`, schemaName })),
          ),
        ),
      },
    },
  } as unknown as ControlPlanePrismaService;

  const tenantPlane = {
    probe: jest.fn(() => {
      if (tenantPlaneError) throw tenantPlaneError;
    }),
    forTenantTransaction: (schema: string, cb: (client: unknown) => Promise<unknown>) =>
      cb({ webhookEndpoint: { count: () => Promise.resolve(activeEndpointsBySchema[schema] ?? 0) } }),
  } as unknown as TenantPrismaService;

  const service = new HealthService(controlPlane, tenantPlane, {
    ...BUILD,
    outboundEnabled: true,
    now: () => clock.now,
    ...options,
  });
  return { service, clock, queryRaw };
}

function serviceFor(controlPlaneError: Error | null, tenantPlaneError: Error | null) {
  return harness(controlPlaneError, tenantPlaneError).service;
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
    expect(report.version).toBe('1.4.2');
  });
});

describe('HealthService.readiness with outbound webhooks switched off (BN-TASK-003)', () => {
  it('reports degraded, with the cause, when ACTIVE endpoints exist', async () => {
    const { service } = harness(null, null, {
      outboundEnabled: false,
      activeEndpointsBySchema: { tenant_a: 0, tenant_b: 2 },
    });
    const report = await service.readiness();
    expect(report.status).toBe('degraded');
    expect(report.reasons).toEqual(['outboundDisabled']);
    expect(report.checks['outbound-webhooks']).toMatchObject({ status: 'down' });
  });

  it('stays ok when switched off and nobody subscribed', async () => {
    const { service } = harness(null, null, {
      outboundEnabled: false,
      activeEndpointsBySchema: { tenant_a: 0 },
    });
    const report = await service.readiness();
    expect(report.status).toBe('ok');
    expect(report.reasons).toEqual([]);
  });

  it('does not even look for endpoints when deliveries are on', async () => {
    const { service } = harness(null, null, {
      outboundEnabled: true,
      activeEndpointsBySchema: { tenant_a: 3 },
    });
    const report = await service.readiness();
    expect(report.status).toBe('ok');
    expect(report.checks['outbound-webhooks']).toMatchObject({ status: 'up' });
  });

  it('names a failing dependency as the reason too', async () => {
    const report = await serviceFor(new Error('down'), null).readiness();
    expect(report.reasons).toContain('control-plane-db');
  });
});

describe('HealthService.readiness cache (BN-TASK-037)', () => {
  it('answers from a 5 s cache instead of probing the databases on every call', async () => {
    const { service, clock, queryRaw } = harness(null, null);
    const first = await service.readiness();
    clock.now += 4_999;
    expect(await service.readiness()).toBe(first);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await service.readiness();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between concurrent callers', async () => {
    const { service, queryRaw } = harness(null, null);
    await Promise.all([service.readiness(), service.readiness(), service.readiness()]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('carries the build version and commit SHA', async () => {
    const report = await serviceFor(null, null).readiness();
    expect(report.build).toEqual(BUILD);
  });
});

describe('readinessFor', () => {
  const report: ReadinessReport = {
    status: 'ok',
    reasons: [],
    uptimeSeconds: 42,
    timestamp: '2026-10-18T00:00:00.000Z',
    version: '1.0.0',
    build: BUILD,
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

  it('keeps the detail, build included, for a verified principal', () => {
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

describe('hasVerifiedPrincipal', () => {
  it('trusts the principal the authentication guard verified and attached', () => {
    expect(hasVerifiedPrincipal({ principal: { kind: 'platform-admin', id: 'a' } })).toBe(true);
  });

  it('does not take a header for proof: a forged bearer token is still anonymous', () => {
    // The guard verifies the token and, on a public route, simply attaches no
    // principal when verification fails. The header alone proves nothing.
    expect(hasVerifiedPrincipal({ headers: { authorization: 'Bearer forged.jwt.value' } })).toBe(false);
    expect(hasVerifiedPrincipal({ headers: { 'x-serverless-authorization': 'Bearer eyJhbGciOi' } })).toBe(
      false,
    );
  });

  it('treats an anonymous probe as anonymous', () => {
    expect(hasVerifiedPrincipal({})).toBe(false);
    expect(hasVerifiedPrincipal({ principal: null })).toBe(false);
  });
});

describe('netpayWebhookDrift in /health/ready (BN-TASK-026)', () => {
  it('adds the cached drift summary to the verified report, never to the public one', async () => {
    const summary = jest.fn(() =>
      Promise.resolve({
        status: 'drift' as const,
        tenantsChecked: 2,
        tenantsDrifted: 1,
        tenantsUnchecked: 0,
        lastCheckedAt: '2026-10-21T00:00:00.000Z',
      }),
    );
    const { service } = harness(null, null, { webhookDrift: { summary } });

    const report = await service.readiness();

    expect(report.netpayWebhookDrift).toMatchObject({ status: 'drift', tenantsDrifted: 1 });
    // Drift is reported and alerted on, but it does not take the instance out of rotation.
    expect(report.status).toBe('ok');
    expect(readinessFor(report, false)).not.toHaveProperty('netpayWebhookDrift');
  });

  it('reports the drift as unknown when the summary cannot be read', async () => {
    const { service } = harness(null, null, {
      webhookDrift: { summary: () => Promise.reject(new Error('db down')) },
    });
    expect((await service.readiness()).netpayWebhookDrift).toMatchObject({ status: 'unknown' });
  });
});
