import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ProviderRateLimiter, ReconciliationService, type ReconcileOptions } from './reconciliation.service';
import type { PaymentOrdersService, ReconcileOrderOutcome } from '../payment-orders.service';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';

/**
 * The reconciliation worker's orchestration (BN-TASK-016): every active tenant,
 * pending results first, a bounded batch of leased orders, a rate limit towards
 * Netpay, and the `reconcile_*` log events the metrics read. What one order turns
 * into is `PaymentOrdersService.reconcileOrder`'s business, covered by
 * `test/reconciliation.int-spec.ts` against PostgreSQL.
 */

const OPTIONS: ReconcileOptions = {
  enabled: true,
  intervalMs: 300_000,
  minAgeMs: 300_000,
  batchSize: 10,
  leaseMs: 300_000,
  threeDsTimeoutMs: 1_800_000,
  chargeUnknownGraceMs: 3_600_000,
  providerRatePerSecond: 5,
  lateWindowMs: 86_400_000,
};

function fixture(
  candidates: Record<string, string[]>,
  outcome: (orderId: string) => Promise<ReconcileOrderOutcome>,
) {
  const tenants = Object.keys(candidates).map((schemaName, i) => ({ id: `t${i}`, schemaName }));
  const controlPlane = {
    client: { tenant: { findMany: jest.fn(() => Promise.resolve(tenants)) } },
  } as unknown as ControlPlanePrismaService;
  const leased: string[] = [];
  const tenantPrisma = {
    forTenantTransaction: (schema: string, cb: (c: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: () => Promise.resolve((candidates[schema] ?? []).map((id) => ({ id }))),
        $executeRaw: () => {
          leased.push(schema);
          return Promise.resolve(1);
        },
      }),
  } as unknown as TenantPrismaService;
  const applyPending = jest.fn(() => Promise.resolve({ applied: 1, alreadyApplied: 0, failed: 0 }));
  const reconcileOrder = jest.fn((_tenant: unknown, orderId: string) => outcome(orderId));
  const orders = {
    applyPendingProviderResults: applyPending,
    reconcileOrder,
  } as unknown as PaymentOrdersService;
  const service = new ReconciliationService(controlPlane, tenantPrisma, orders, OPTIONS);
  return { service, applyPending, reconcileOrder, leased };
}

const corrected = (from: string, to: string): Promise<ReconcileOrderOutcome> =>
  Promise.resolve({ from, to, corrected: true, action: 'verified' });
const unchanged = (status: string): Promise<ReconcileOrderOutcome> =>
  Promise.resolve({ from: status, to: status, corrected: false, action: 'unchanged' });

describe('ReconciliationService (BN-TASK-016)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('visits every active tenant: pending results first, then its leased orders', async () => {
    const f = fixture({ tenant_a_1: ['o1', 'o2'], tenant_b_2: ['o3'] }, (id) =>
      id === 'o2' ? corrected('PENDING', 'PAID') : unchanged('PENDING_VERIFICATION'),
    );

    const summary = await f.service.runOnce();

    expect(f.applyPending).toHaveBeenCalledTimes(2);
    expect(f.reconcileOrder.mock.calls.map((c) => c[1])).toEqual(['o1', 'o2', 'o3']);
    expect(f.leased).toEqual(['tenant_a_1', 'tenant_b_2']);
    expect(summary).toEqual({ tenants: 2, checked: 3, corrected: 1, errors: 0, pendingApplied: 2 });
  });

  it('counts an order that fails and goes on with the next one', async () => {
    const f = fixture({ tenant_a_1: ['bad', 'good'] }, (id) =>
      id === 'bad' ? Promise.reject(new Error('netpay down')) : corrected('PENDING', 'PAID'),
    );

    const summary = await f.service.runOnce();

    expect(summary).toMatchObject({ checked: 2, corrected: 1, errors: 1 });
  });

  it('emits reconcile_checked, reconcile_corrected and reconcile_errors for the log-based metrics', async () => {
    const lines: Record<string, unknown>[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((entry: unknown) => {
      lines.push(entry as Record<string, unknown>);
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((entry: unknown) => {
      lines.push(entry as Record<string, unknown>);
    });
    const f = fixture({ tenant_a_1: ['o1', 'o2'] }, (id) =>
      id === 'o1' ? corrected('WAIT', 'EXPIRED') : Promise.reject(new Error('x')),
    );

    await f.service.runOnce();

    const events = lines.filter((l) => typeof l === 'object' && l !== null && 'event' in l);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'reconcile_corrected', from: 'WAIT', to: 'EXPIRED' }),
        expect.objectContaining({ event: 'reconcile_errors', count: 1 }),
        expect.objectContaining({ event: 'reconcile_checked', count: 2 }),
      ]),
    );
  });

  it('does not overlap itself: a pass while one runs is skipped', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ tenant_a_1: ['o1'] }, async () => {
      await gate;
      return unchanged('PENDING');
    });

    const first = f.service.runOnce();
    const second = await f.service.runOnce();
    release();

    expect(second).toMatchObject({ skipped: true, checked: 0 });
    expect((await first).checked).toBe(1);
  });

  it('starts no timer when disabled or with a zero interval', () => {
    const spy = jest.spyOn(global, 'setTimeout');
    for (const options of [
      { ...OPTIONS, enabled: false },
      { ...OPTIONS, intervalMs: 0 },
    ]) {
      const service = new ReconciliationService(
        {} as ControlPlanePrismaService,
        {} as TenantPrismaService,
        {} as PaymentOrdersService,
        options,
      );
      service.onApplicationBootstrap();
      service.onModuleDestroy();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('schedules itself, unref’d, while the instance lives', () => {
    const service = new ReconciliationService(
      {} as ControlPlanePrismaService,
      {} as TenantPrismaService,
      {} as PaymentOrdersService,
      OPTIONS,
    );
    const spy = jest.spyOn(global, 'setTimeout');
    service.onApplicationBootstrap();
    expect(spy).toHaveBeenCalledTimes(1);
    const delay = spy.mock.calls[0][1] as number;
    // First pass after one interval (plus jitter), never at boot: a cold start serves its request first.
    expect(delay).toBeGreaterThanOrEqual(OPTIONS.intervalMs);
    expect(delay).toBeLessThanOrEqual(OPTIONS.intervalMs * 1.2);
    service.onModuleDestroy();
  });
});

describe('ProviderRateLimiter (BN-REQ-REC-004)', () => {
  it('spaces calls of one tenant to the configured rate', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new ProviderRateLimiter(5, {
      now: () => now,
      sleep: (ms: number) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });

    for (let i = 0; i < 6; i += 1) {
      await limiter.acquire();
    }

    // Five per second: the first goes at once, each next one 200 ms later.
    expect(waits).toEqual([200, 200, 200, 200, 200]);
    expect(now).toBe(1000);
  });

  it('does not wait when calls are already slower than the rate', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new ProviderRateLimiter(5, {
      now: () => now,
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await limiter.acquire();
    now = 500;
    await limiter.acquire();
    expect(waits).toEqual([]);
  });
});
