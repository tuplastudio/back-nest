import 'reflect-metadata';
import {
  OutboundDispatcher,
  type OutboundOptions,
  type OutboundTransport,
} from './outbound-dispatcher.service';
import { PaymentSecretBox } from '../payment-secret-box';
import { UrlGuard, type DnsResolver } from './url-guard';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';

/**
 * Fairness and concurrency of one dispatch cycle (BN-TASK-006, BN-REQ-EVT-008).
 *
 * The fake keeps one queue per tenant schema and answers only the queries the
 * cycle makes: tenant pages, due rows per schema, claims and outcomes. What is
 * under test is the order and overlap of the requests the dispatcher sends.
 */

interface Row {
  id: string;
  endpointId: string;
  status: string;
  attempt: number;
  nextAttemptAt: Date | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  createdAt: Date;
}

interface Tenant {
  id: string;
  schemaName: string;
  endpoint: { id: string; url: string; tenantId: string };
  rows: Row[];
}

const SLOW_HOST = 'slow.example.com';

/** Resolves once every pending promise callback has run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * @param tenantCount Number of active tenants, each with one endpoint.
 * @param rowsPerTenant Due deliveries per tenant.
 * @param slowRows Due deliveries for the slow endpoint (tenant 0).
 * @param tuning Overrides.
 */
function harness(
  tenantCount: number,
  rowsPerTenant: number,
  slowRows: number,
  tuning: Partial<OutboundOptions> = {},
) {
  const box = new PaymentSecretBox(Buffer.alloc(32, 5).toString('base64'));
  const clock = { now: Date.now() };
  const tenants: Tenant[] = [];
  for (let t = 0; t < tenantCount; t += 1) {
    const id = `00000000-0000-4000-8000-${t.toString().padStart(12, '0')}`;
    const endpointId = `ep-${t}`;
    const count = t === 0 ? slowRows : rowsPerTenant;
    tenants.push({
      id,
      schemaName: `tenant_${t}`,
      endpoint: {
        id: endpointId,
        url: `https://${t === 0 ? SLOW_HOST : `t${t}.example.com`}/hook`,
        tenantId: id,
      },
      rows: Array.from({ length: count }, (_, i) => ({
        id: `${endpointId}-d${i}`,
        endpointId,
        status: 'PENDING',
        attempt: 1,
        nextAttemptAt: new Date(clock.now - 1000),
        lockedAt: null,
        lockedBy: null,
        createdAt: new Date(clock.now - 1000 + i),
      })),
    });
  }
  const bySchema = new Map(tenants.map((t) => [t.schemaName, t]));

  const clientFor = (tenant: Tenant) => ({
    // Outbox fan-out: nothing pending; the rows below are already fanned out.
    $queryRaw: () => Promise.resolve([]),
    webhookDelivery: {
      findMany: (args: { take: number; where: { nextAttemptAt: { lte: Date } } }) =>
        Promise.resolve(
          tenant.rows
            .filter(
              (r) =>
                (r.status === 'PENDING' || r.status === 'FAILED') &&
                r.lockedAt === null &&
                r.nextAttemptAt !== null &&
                r.nextAttemptAt.getTime() <= args.where.nextAttemptAt.lte.getTime(),
            )
            .slice(0, args.take)
            .map((r) => ({
              ...r,
              eventId: `evt_${r.id}`,
              eventType: 'payment.paid',
              sequence: 1,
              endpoint: {
                ...tenant.endpoint,
                secretCiphertext: box.encrypt('whsec_x', PaymentSecretBox.aadForEndpoint(tenant.endpoint.id)),
                previousSecretCiphertext: null,
              },
              order: null,
            })),
        ),
      updateMany: (args: { where: { id: { in: string[] } }; data: Partial<Row> }) => {
        const rows = tenant.rows.filter((r) => args.where.id.in.includes(r.id));
        for (const row of rows) Object.assign(row, args.data);
        return Promise.resolve({ count: rows.length });
      },
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tenant.rows.find((r) => r.id === args.where.id)!;
        const { attempt, ...rest } = args.data;
        Object.assign(row, rest);
        row.attempt += (attempt as { increment: number }).increment;
        return Promise.resolve(row);
      },
      findFirst: () => Promise.resolve(null),
    },
    webhookEndpoint: {
      findFirstOrThrow: () => Promise.resolve({ consecutiveFailures: 0 }),
      update: () => Promise.resolve({}),
    },
  });

  const tenantPrisma = {
    forTenantTransaction: (schema: string, cb: (c: unknown) => Promise<unknown>) =>
      cb(clientFor(bySchema.get(schema)!)),
  } as unknown as TenantPrismaService;

  const pageSizes: number[] = [];
  const controlPlane = {
    client: {
      tenant: {
        findMany: (args: { take: number; where: { id?: { gt: string } } }) => {
          pageSizes.push(args.take);
          const after = args.where.id?.gt;
          const sorted = [...tenants].sort((a, b) => a.id.localeCompare(b.id));
          const from = after === undefined ? 0 : sorted.findIndex((t) => t.id > after);
          return Promise.resolve(
            (from === -1 ? [] : sorted.slice(from, from + args.take)).map((t) => ({
              id: t.id,
              schemaName: t.schemaName,
            })),
          );
        },
      },
    },
  } as unknown as ControlPlanePrismaService;

  // The slow endpoint never answers until the test lets it.
  const slowRelease: (() => void)[] = [];
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let slowInFlight = 0;
  let maxSlowInFlight = 0;
  const transport: OutboundTransport = {
    request: async (destination) => {
      const host = new URL(destination.url).hostname;
      order.push(host);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (host === SLOW_HOST) {
          slowInFlight += 1;
          maxSlowInFlight = Math.max(maxSlowInFlight, slowInFlight);
          await new Promise<void>((resolve) => slowRelease.push(resolve));
          slowInFlight -= 1;
        } else {
          await settle();
        }
        return { status: 200 };
      } finally {
        inFlight -= 1;
      }
    },
  };
  const dns: DnsResolver = { lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) };

  const options: OutboundOptions = {
    maxAttempts: 100,
    baseBackoffMs: 1000,
    maxBackoffMs: 3_600_000,
    jitterMs: 0,
    timeoutMs: 8000,
    pollIntervalMs: 0,
    batchSize: 10,
    autoDisableAfter: 20,
    maxTenantsPerTick: 50,
    maxAgeMs: 24 * 3_600_000,
    concurrency: 8,
    ...tuning,
  };
  const dispatcher = new OutboundDispatcher(
    tenantPrisma,
    controlPlane,
    transport,
    new UrlGuard(dns, true),
    box,
    options,
    () => clock.now,
  );

  const releaseSlow = (): void => {
    for (const resolve of slowRelease.splice(0)) resolve();
  };

  return {
    dispatcher,
    tenants,
    clock,
    order,
    pageSizes,
    releaseSlow,
    stats: () => ({ maxInFlight, maxSlowInFlight, slowWaiting: slowRelease.length }),
  };
}

/** Lets the cycle run until nothing else can make progress without the slow endpoint. */
async function runUntilIdle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await settle();
  }
}

describe('OutboundDispatcher fairness (BN-TASK-006)', () => {
  it('drains all 300 tenants in one cycle while an 8 s endpoint is still answering', async () => {
    const h = harness(300, 1, 5);
    const cycle = h.dispatcher.drainOnce();
    await runUntilIdle();

    // Every other tenant has been served while the slow endpoint still holds
    // its requests open.
    const delivered = h.tenants.slice(1).filter((t) => t.rows.every((r) => r.status === 'DELIVERED'));
    expect(delivered).toHaveLength(299);
    expect(h.stats().slowWaiting).toBeGreaterThan(0);

    for (let i = 0; i < 10; i += 1) {
      h.releaseSlow();
      await runUntilIdle();
    }
    // 299 tenants with one row each, plus the slow endpoint's five.
    await expect(cycle).resolves.toBe(304);
    expect(h.tenants[0].rows.every((r) => r.status === 'DELIVERED')).toBe(true);
  });

  it('enumerates tenants in pages instead of stopping at the first page', async () => {
    const h = harness(120, 1, 1, { maxTenantsPerTick: 50 });
    const cycle = h.dispatcher.drainOnce();
    await runUntilIdle();
    h.releaseSlow();
    await expect(cycle).resolves.toBe(120);
    expect(h.pageSizes).toEqual([50, 50, 50]);
  });

  it('never has more than 8 deliveries in flight, nor more than a quarter for one endpoint', async () => {
    const h = harness(40, 3, 30);
    const cycle = h.dispatcher.drainOnce();
    for (let i = 0; i < 40; i += 1) {
      await runUntilIdle();
      h.releaseSlow();
    }
    await cycle;
    expect(h.stats().maxInFlight).toBeLessThanOrEqual(8);
    expect(h.stats().maxInFlight).toBeGreaterThan(1);
    expect(h.stats().maxSlowInFlight).toBeLessThanOrEqual(2);
  });

  it('interleaves tenants round-robin, so a large backlog does not go first', async () => {
    // Tenant 0 has 10 due rows, the others one each; with one slot the order
    // is exactly the queue order.
    const h = harness(5, 1, 10, { concurrency: 1 });
    const cycle = h.dispatcher.drainOnce();
    for (let i = 0; i < 20; i += 1) {
      await runUntilIdle();
      h.releaseSlow();
    }
    await cycle;
    // One row per tenant first, then the rest of the backlog.
    expect(new Set(h.order.slice(0, 5)).size).toBe(5);
    expect(h.order.slice(5).every((host) => host === SLOW_HOST)).toBe(true);
  });

  it('rotates the tenant served first from one cycle to the next', async () => {
    const h = harness(3, 1, 1, { concurrency: 1 });
    await (async () => {
      const cycle = h.dispatcher.drainOnce();
      await runUntilIdle();
      h.releaseSlow();
      await cycle;
    })();
    const firstCycleStart = h.order[0];
    for (const t of h.tenants) for (const r of t.rows) Object.assign(r, { status: 'PENDING' });
    h.order.length = 0;
    const cycle = h.dispatcher.drainOnce();
    await runUntilIdle();
    h.releaseSlow();
    await cycle;
    expect(h.order[0]).not.toBe(firstCycleStart);
  });

  it('hands back the slow backlog when the cycle runs out of time, instead of holding everyone up', async () => {
    const h = harness(3, 1, 20, { concurrency: 4, timeoutMs: 8000 });
    const cycle = h.dispatcher.drainOnce();
    await runUntilIdle();
    // One slow request is open (a quarter of 4 slots); the budget then runs out.
    h.clock.now += 8000;
    h.releaseSlow();
    await runUntilIdle();
    h.releaseSlow();
    await cycle;
    const slow = h.tenants[0].rows;
    const untouched = slow.filter((r) => r.status === 'PENDING');
    expect(untouched.length).toBeGreaterThan(0);
    // Released, so the next cycle (here or on another instance) can take them.
    expect(untouched.every((r) => r.lockedAt === null && r.lockedBy === null)).toBe(true);
    // The other tenants were not affected.
    expect(h.tenants.slice(1).every((t) => t.rows.every((r) => r.status === 'DELIVERED'))).toBe(true);
  });
});
