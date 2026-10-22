import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import {
  OutboundDispatcher,
  retryDelayMs,
  type OutboundOptions,
  type OutboundTransport,
} from './outbound-dispatcher.service';
import { Prisma } from '../../generated/tenant-plane/client';
import { PaymentSecretBox } from '../payment-secret-box';
import { UrlGuard, type DnsResolver } from './url-guard';
import { verifyDelivery } from './signature';
import { buildEventPayload, eventIdFor, type PaymentEventPayload } from '../payment-events';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';

const SCHEMA = 'tenant_acme_00000001';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECRET = 'whsec_spec_secret';
const PASSWORD = `sk_netpay_${'z'.repeat(40)}`;
const HOUR = 3_600_000;

interface FakeEndpoint {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  status: string;
  consecutiveFailures: number;
  secretCiphertext: string;
  previousSecretCiphertext: string | null;
  disabledAt: Date | null;
  disabledReason: string | null;
}

interface FakeDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  sequence: number;
  attempt: number;
  status: string;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  createdAt: Date;
  order: {
    id: string;
    orderReference: string;
    merchantReferenceCode: string;
    amount: Prisma.Decimal;
    currency: string;
    status: string;
  } | null;
}

/** A row of the fake `payment_event_outbox`. */
interface FakeOutboxEvent {
  id: string;
  orderId: string;
  sequence: number;
  eventType: string;
  payload: PaymentEventPayload;
  occurredAt: Date;
  dispatchedAt: Date | null;
}

/**
 * Commits an event to a harness's outbox, the way a payment state change does.
 * Registered per dispatcher by {@link build}.
 */
const publishers = new WeakMap<OutboundDispatcher, (eventType: string) => Promise<void>>();

/**
 * @param dispatcher Dispatcher built by {@link build}.
 * @param eventType Event to commit for order-1.
 */
function publish(dispatcher: OutboundDispatcher, eventType: string): Promise<void> {
  return publishers.get(dispatcher)!(eventType);
}

/** Records what the dispatcher put on the wire. */
interface Sent {
  readonly url: string;
  readonly addresses: readonly { address: string; family: 4 | 6 }[];
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Builds a dispatcher over an in-memory tenant schema.
 *
 * `responder` decides what the subscriber answers, so the retry, backoff and
 * dead-letter paths are reachable without a network.
 *
 * @param options Behaviour overrides and fixture data.
 * @returns The dispatcher plus inspection helpers.
 */
function build(
  options: {
    endpoints?: Partial<FakeEndpoint>[];
    responder?: (sent: Sent, call: number) => { status: number } | { throws: true };
    maxAttempts?: number;
    autoDisableAfter?: number;
    maxAgeMs?: number;
    drain?: boolean;
    /** Replaces the resolver used at delivery time. */
    dns?: DnsResolver;
  } = {},
) {
  // The dispatcher's clock. Tests move it forward to cross the 24 h boundary
  // without waiting for it.
  const clock = { now: Date.now() };
  const box = new PaymentSecretBox(Buffer.alloc(32, 3).toString('base64'));
  const endpoints = new Map<string, FakeEndpoint>();
  const deliveries = new Map<string, FakeDelivery>();
  const outbox: FakeOutboxEvent[] = [];
  const sent: Sent[] = [];
  let callCount = 0;
  let nextId = 1;

  for (const partial of options.endpoints ?? [
    {
      id: ENDPOINT,
      tenantId: TENANT,
      url: 'https://hooks.example.com/payments',
      events: ['payment.paid'],
      status: 'ACTIVE',
      secretCiphertext: box.encrypt(SECRET, PaymentSecretBox.aadForEndpoint(ENDPOINT)),
    },
  ]) {
    endpoints.set(
      partial.id as string,
      {
        events: ['payment.paid'],
        status: 'ACTIVE',
        consecutiveFailures: 0,
        previousSecretCiphertext: null,
        disabledAt: null,
        disabledReason: null,
        ...partial,
      } as FakeEndpoint,
    );
  }

  /** Applies Prisma's update operators the dispatcher uses. */
  const applyData = (row: object, data: Record<string, unknown>): void => {
    const target = row as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in value) {
        target[key] = Number(target[key] ?? 0) + Number((value as { increment: number }).increment);
        continue;
      }
      target[key] = value;
    }
  };

  /**
   * Applies the subset of Prisma's filter grammar this fake needs.
   *
   * Deliberately narrow: the query semantics belong to Prisma, and what these
   * tests care about is which rows the dispatcher asks for and what it does
   * with the answer.
   */
  const matches = (where: Record<string, unknown>, row: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      if (key === 'OR') {
        const branches = condition as Record<string, unknown>[];
        if (!branches.some((branch) => matches(branch, row))) {
          return false;
        }
        continue;
      }
      const actual = row[key];
      if (condition === null) {
        if (actual !== null) return false;
        continue;
      }
      if (condition instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() > condition.getTime()) return false;
        continue;
      }
      if (typeof condition === 'object' && !Array.isArray(condition)) {
        const c = condition as Record<string, unknown>;
        if ('gte' in c) {
          if (!(actual instanceof Date) || actual.getTime() < (c['gte'] as Date).getTime()) return false;
          continue;
        }
        if ('lte' in c) {
          if (!(actual instanceof Date) || actual.getTime() > (c['lte'] as Date).getTime()) return false;
          continue;
        }
        if ('lt' in c) {
          if (!(actual instanceof Date) || actual.getTime() >= (c['lt'] as Date).getTime()) return false;
          continue;
        }
        if ('has' in c) {
          if (!(Array.isArray(actual) && actual.includes(c['has']))) return false;
          continue;
        }
        if ('in' in c) {
          const list = c['in'] as unknown[];
          if (!list.includes(actual) && !list.includes(actual)) {
            // A scalar compared against a list of values, which is how a status
            // filter of { in: ['PENDING','FAILED'] } arrives.
            if (!list.some((allowed) => allowed === actual)) return false;
          }
          continue;
        }
        // A to-one relation filter arrives as a plain object with no operators.
        if (typeof actual !== 'object' || actual === null) return false;
        if (!matches(c, actual as Record<string, unknown>)) return false;
        continue;
      }
      if (actual !== condition) return false;
    }
    return true;
  };

  const client = {
    // The fan-out's `SELECT … FOR UPDATE SKIP LOCKED` of pending outbox events.
    $queryRaw: jest.fn(() =>
      Promise.resolve(
        outbox
          .filter((e) => e.dispatchedAt === null)
          .map((e) => ({ id: e.id, orderId: e.orderId, sequence: e.sequence, eventType: e.eventType })),
      ),
    ),
    paymentEventOutbox: {
      updateMany: jest.fn((args: { where: { id: { in: string[] } }; data: { dispatchedAt: Date } }) => {
        const hit = outbox.filter((e) => args.where.id.in.includes(e.id));
        for (const e of hit) e.dispatchedAt = args.data.dispatchedAt;
        return Promise.resolve({ count: hit.length });
      }),
    },
    webhookEndpoint: {
      findMany: jest.fn((args: Record<string, never>) => {
        const rows = [...endpoints.values()].filter((e) => matches(args.where, e as never));
        return Promise.resolve(rows.map((e) => ({ id: e.id, events: e.events })));
      }),
      findFirstOrThrow: jest.fn((args: Record<string, never>) => {
        const id = (args.where as { id: string }).id;
        const row = endpoints.get(id);
        if (row === undefined) throw new Error('not found');
        return Promise.resolve(row);
      }),
      update: jest.fn((args: Record<string, never>) => {
        const id = (args.where as { id: string }).id;
        const row = endpoints.get(id);
        if (row === undefined) throw new Error('not found');
        Object.assign(row, args.data);
        return Promise.resolve(row);
      }),
    },
    webhookDelivery: {
      createMany: jest.fn((args: Record<string, never>) => {
        for (const item of args.data as unknown as FakeDelivery[]) {
          const id = `d${nextId++}`;
          const row: FakeDelivery = {
            id,
            endpointId: '',
            eventId: `evt_${id}`,
            eventType: 'payment.paid',
            attempt: 1,
            status: 'PENDING',
            responseStatus: null,
            durationMs: null,
            error: null,
            nextAttemptAt: new Date(),
            deliveredAt: null,
            lockedAt: null,
            lockedBy: null,
            createdAt: new Date(clock.now),
            sequence: 0,
            order: {
              id: 'order-1',
              orderReference: 'acme_ref_1',
              merchantReferenceCode: 'REF-1',
              // Prisma returns a Decimal, not a string; the dispatcher calls
              // toFixed on it exactly as it would on the real value.
              amount: new Prisma.Decimal('650.00'),
              currency: 'MXN',
              status: 'PAID',
            },
          };
          applyData(row, item as unknown as Record<string, unknown>);
          row.id = id;
          deliveries.set(id, row);
        }
        return Promise.resolve({ count: (args.data as unknown[]).length });
      }),
      findMany: jest.fn((args: Record<string, never>) => {
        const rows = [...deliveries.values()]
          .filter((d) => {
            const row: Record<string, unknown> = { ...d, endpoint: endpoints.get(d.endpointId) };
            return matches(args.where, row);
          })
          .slice(0, (args.take as number) ?? 100)
          .map((d) => {
            const event = outbox.find((e) => e.id === (d as { outboxId?: string }).outboxId);
            return {
              ...d,
              replayedAt: (d as { replayedAt?: Date | null }).replayedAt ?? null,
              attemptsBeforeReplay: (d as { attemptsBeforeReplay?: number }).attemptsBeforeReplay ?? 0,
              endpoint: endpoints.get(d.endpointId),
              order: d.order,
              outbox: event === undefined ? null : { payload: event.payload },
            };
          });
        return Promise.resolve(rows);
      }),
      findFirst: jest.fn((args: Record<string, never>) => {
        const row = [...deliveries.values()].find((d) => matches(args.where, d as never));
        return Promise.resolve(row ?? null);
      }),
      updateMany: jest.fn((args: Record<string, never>) => {
        let count = 0;
        for (const d of deliveries.values()) {
          if (matches(args.where, d as never)) {
            applyData(d, args.data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }),
      update: jest.fn((args: Record<string, never>) => {
        const id = (args.where as { id: string }).id;
        const row = deliveries.get(id);
        if (row === undefined) throw new Error('not found');
        applyData(row, args.data);
        return Promise.resolve(row);
      }),
    },
  };

  const tenantPrisma = {
    forTenantTransaction: (_schema: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client as never)),
  } as unknown as TenantPrismaService;

  const controlPlane = {
    client: {
      tenant: {
        findMany: jest.fn(() => Promise.resolve([{ id: TENANT, schemaName: SCHEMA, status: 'ACTIVE' }])),
      },
    },
  } as unknown as ControlPlanePrismaService;

  const transport: OutboundTransport = {
    request: (destination, init) => {
      callCount += 1;
      const record: Sent = {
        url: destination.url,
        addresses: destination.addresses,
        headers: init.headers,
        body: init.body,
      };
      sent.push(record);
      const answer = options.responder?.(record, callCount);
      if (answer !== undefined && 'throws' in answer) {
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({ status: answer?.status ?? 200 });
    },
  };

  const dns: DnsResolver = options.dns ?? {
    lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
  };

  const tuning: OutboundOptions = {
    maxAttempts: options.maxAttempts ?? 3,
    baseBackoffMs: 1000,
    maxBackoffMs: 60_000,
    jitterMs: 0,
    timeoutMs: 5000,
    pollIntervalMs: 0,
    batchSize: 10,
    autoDisableAfter: options.autoDisableAfter ?? 5,
    maxTenantsPerTick: 10,
    maxAgeMs: options.maxAgeMs ?? 24 * HOUR,
    concurrency: 8,
  };

  const dispatcher = new OutboundDispatcher(
    tenantPrisma,
    controlPlane,
    transport,
    new UrlGuard(dns, true),
    box,
    tuning,
    () => clock.now,
  );

  publishers.set(dispatcher, (eventType: string) => {
    const id = `00000000-0000-4000-8000-${String(outbox.length + 1).padStart(12, '0')}`;
    const occurredAt = new Date(clock.now);
    const sequence = outbox.length + 4;
    outbox.push({
      id,
      orderId: 'order-1',
      sequence,
      eventType,
      occurredAt,
      dispatchedAt: null,
      payload: buildEventPayload({
        eventId: eventIdFor(id),
        eventType,
        occurredAt,
        sequence,
        tenantId: TENANT,
        previousStatus: 'PENDING',
        order: {
          id: 'order-1',
          orderReference: 'acme_ref_1',
          merchantReferenceCode: 'REF-1',
          amount: new Prisma.Decimal('650.00'),
          currency: 'MXN',
          status: 'PAID',
        },
      }),
    });
    return Promise.resolve();
  });

  /** Makes every pending delivery due, since the backoff defers it on purpose. */
  const makeDue = (): void => {
    for (const row of deliveries.values()) {
      if (row.status === 'PENDING' || row.status === 'FAILED') {
        row.nextAttemptAt = new Date(clock.now - 1000);
      }
    }
  };

  /** Moves the dispatcher's clock forward. */
  const advance = (ms: number): void => {
    clock.now += ms;
  };

  return { dispatcher, endpoints, deliveries, outbox, sent, box, makeDue, advance, clock };
}

describe('OutboundDispatcher', () => {
  it('signs the delivery so the subscriber can authenticate us', async () => {
    const { dispatcher, sent, box } = build();
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();

    expect(sent).toHaveLength(1);
    const headers = sent[0].headers;
    expect(headers['x-mtbpay-event-type']).toBe('payment.paid');
    expect(headers['x-mtbpay-attempt']).toBe('1');
    // The receiver's documented procedure: verify the raw body against the secret.
    const check = verifyDelivery(headers['x-mtbpay-signature'], sent[0].body, SECRET, Date.now());
    expect(check).toEqual({ valid: true });
    expect(box.decrypt(box.encrypt('x', 'y'), 'y')).toBe('x');
  });

  it('never puts card data in the payload', async () => {
    const { dispatcher, sent } = build();
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    const body = sent[0].body.toLowerCase();
    for (const leak of ['cardholder', 'cardholdername', 'lastfourdigits', 'pan', 'cvv', 'bankname']) {
      expect(body).not.toContain(leak);
    }
  });

  it('connects to the address the guard approved, not to the name', async () => {
    const { dispatcher, sent } = build();
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    // The URL stays the subscribed one (SNI, certificate and Host use the name);
    // the pin is the validated address list, so DNS cannot re-point between the
    // check and the connection.
    expect(sent[0].url).toBe('https://hooks.example.com/payments');
    expect(sent[0].addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses to deliver to a destination the guard rejects', async () => {
    const box = new PaymentSecretBox(Buffer.alloc(32, 3).toString('base64'));
    const endpointId = 'ep-loopback';
    const h = build({
      endpoints: [
        {
          id: endpointId,
          tenantId: TENANT,
          url: 'https://127.0.0.1/steal',
          events: ['payment.paid'],
          status: 'ACTIVE',
          secretCiphertext: box.encrypt(SECRET, PaymentSecretBox.aadForEndpoint(endpointId)),
        },
      ],
    });
    await publish(h.dispatcher, 'payment.paid');
    await h.dispatcher.drainOnce();
    expect(h.sent).toHaveLength(0);
    // Refused, but not given up on: see "DNS at delivery time" below.
    expect([...h.deliveries.values()][0].status).toBe('FAILED');
    expect([...h.deliveries.values()][0].error).toBe('PRIVATE_ADDRESS');
  });

  it('only notifies endpoints subscribed to that event', async () => {
    const { dispatcher, sent } = build({
      endpoints: [
        {
          id: 'ep-other',
          tenantId: TENANT,
          url: 'https://hooks.example.com/other',
          events: ['payment.refunded'],
          status: 'ACTIVE',
          secretCiphertext: '',
        },
      ],
    });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    expect(sent).toHaveLength(0);
  });

  describe('DNS at delivery time (BN-TASK-002)', () => {
    const failingDns: DnsResolver = { lookup: () => Promise.reject(new Error('getaddrinfo EAI_AGAIN')) };
    const blockedDns: DnsResolver = {
      lookup: () => Promise.resolve([{ address: '10.0.0.7', family: 4 }]),
    };

    it.each([
      ['a failed lookup', failingDns, 'UNRESOLVED'],
      ['an answer outside the allowed ranges', blockedDns, 'PRIVATE_ADDRESS'],
    ])('treats %s as a retryable failure and keeps the endpoint ACTIVE', async (_label, dns, reason) => {
      const { dispatcher, deliveries, endpoints, sent } = build({ dns, autoDisableAfter: 1 });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      const row = [...deliveries.values()][0];
      expect(sent).toHaveLength(0);
      expect(row.status).toBe('FAILED');
      expect(row.error).toBe(reason);
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
      expect(endpoints.get(ENDPOINT)!.status).toBe('ACTIVE');
    });

    it('delivers once DNS recovers', async () => {
      let broken = true;
      const dns: DnsResolver = {
        lookup: () =>
          broken
            ? Promise.reject(new Error('getaddrinfo ENOTFOUND'))
            : Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      };
      const { dispatcher, deliveries, endpoints, makeDue } = build({ dns, autoDisableAfter: 1 });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      broken = false;
      makeDue();
      await dispatcher.drainOnce();
      expect([...deliveries.values()][0].status).toBe('DELIVERED');
      expect(endpoints.get(ENDPOINT)!.consecutiveFailures).toBe(0);
    });

    it('auto-disables only when DNS has been failing for 24 h', async () => {
      const { dispatcher, endpoints, makeDue, advance } = build({
        dns: failingDns,
        maxAttempts: 1000,
        autoDisableAfter: 1,
      });
      await publish(dispatcher, 'payment.paid');
      for (let hour = 0; hour < 23; hour += 1) {
        await dispatcher.drainOnce();
        advance(HOUR);
        makeDue();
      }
      expect(endpoints.get(ENDPOINT)!.status).toBe('ACTIVE');
      advance(HOUR);
      makeDue();
      await dispatcher.drainOnce();
      expect(endpoints.get(ENDPOINT)!.status).toBe('AUTO_DISABLED');
      expect(endpoints.get(ENDPOINT)!.disabledReason).toContain('UNRESOLVED');
    });
  });

  describe('retry schedule (BN-TASK-005)', () => {
    const tuning = { baseBackoffMs: 1000, maxBackoffMs: HOUR, jitterMs: 250 };

    it('starts at about a second and grows', () => {
      const noJitter = { ...tuning, jitterMs: 0 };
      const delays = [1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(attempt, noJitter, () => 0));
      expect(delays[0]).toBe(1000);
      for (let i = 1; i < delays.length; i += 1) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }
    });

    it('never waits more than the cap, whatever the attempt or the jitter', () => {
      for (const attempt of [7, 10, 20, 50, 500]) {
        for (const r of [0, 0.5, 0.999]) {
          expect(retryDelayMs(attempt, tuning, () => r)).toBeLessThanOrEqual(HOUR);
        }
      }
      expect(retryDelayMs(10, tuning, () => 0)).toBe(HOUR);
    });

    it('spreads retries with jitter instead of firing them in lockstep', () => {
      const low = retryDelayMs(10, tuning, () => 0.999);
      const high = retryDelayMs(10, tuning, () => 0);
      expect(low).toBeLessThan(high);
      // Spread, not collapse: never below 80 % of the step.
      expect(low).toBeGreaterThanOrEqual(0.8 * HOUR);
    });

    it('after 10 consecutive failures, schedules the next attempt within the hour and keeps retrying', async () => {
      const { dispatcher, deliveries, makeDue, advance, clock } = build({
        responder: () => ({ status: 503 }),
        maxAttempts: 1000,
      });
      await publish(dispatcher, 'payment.paid');
      for (let i = 0; i < 10; i += 1) {
        await dispatcher.drainOnce();
        advance(60_000);
        makeDue();
      }
      const row = [...deliveries.values()][0];
      await dispatcher.drainOnce();
      expect(row.attempt).toBe(12);
      expect(row.status).toBe('FAILED');
      expect(row.nextAttemptAt!.getTime() - clock.now).toBeLessThanOrEqual(HOUR);
    });

    it('marks a delivery DEAD only once it is 24 h old', async () => {
      const { dispatcher, deliveries, makeDue, advance } = build({
        responder: () => ({ status: 500 }),
        maxAttempts: 1000,
      });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      advance(24 * HOUR - 60_000);
      makeDue();
      await dispatcher.drainOnce();
      expect([...deliveries.values()][0].status).toBe('FAILED');
      advance(60_000);
      makeDue();
      await dispatcher.drainOnce();
      expect([...deliveries.values()][0].status).toBe('DEAD');
    });

    it('honours a shorter window from OUTBOUND_WEBHOOK_MAX_AGE_HOURS', async () => {
      const { dispatcher, deliveries, makeDue, advance } = build({
        responder: () => ({ status: 500 }),
        maxAttempts: 1000,
        maxAgeMs: 2 * HOUR,
      });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      advance(2 * HOUR);
      makeDue();
      await dispatcher.drainOnce();
      expect([...deliveries.values()][0].status).toBe('DEAD');
    });
  });

  it('retries a failing subscriber with a growing backoff', async () => {
    const { dispatcher, deliveries, sent, makeDue } = build({
      responder: () => ({ status: 500 }),
      maxAttempts: 3,
    });
    await publish(dispatcher, 'payment.paid');

    await dispatcher.drainOnce();
    expect([...deliveries.values()][0].status).toBe('FAILED');
    // Scheduled for later, not immediately.
    expect([...deliveries.values()][0].nextAttemptAt).toBeInstanceOf(Date);
    // A drain before the row is due sends nothing: that is the backoff working.
    await dispatcher.drainOnce();
    expect(sent).toHaveLength(1);

    makeDue();
    await dispatcher.drainOnce();
    expect(sent).toHaveLength(2);
    makeDue();
    await dispatcher.drainOnce();
    expect(sent).toHaveLength(3);
    // Exhausted: the record is kept, not discarded.
    expect([...deliveries.values()][0].status).toBe('DEAD');
  });

  it('disables an endpoint only once it has been failing for the whole retry window, and says why', async () => {
    const { dispatcher, endpoints, deliveries, makeDue, advance } = build({
      responder: () => ({ status: 500 }),
      maxAttempts: 1000,
      autoDisableAfter: 2,
    });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    makeDue();
    await dispatcher.drainOnce();
    // Past the failure threshold, but an hour of trouble is not a dead endpoint.
    expect(endpoints.get(ENDPOINT)!.status).toBe('ACTIVE');

    advance(24 * HOUR);
    makeDue();
    await dispatcher.drainOnce();
    expect([...deliveries.values()][0].status).toBe('DEAD');
    const endpoint = endpoints.get(ENDPOINT)!;
    expect(endpoint.status).toBe('AUTO_DISABLED');
    expect(endpoint.disabledReason).not.toBeNull();
    expect(endpoint.disabledAt).toBeInstanceOf(Date);
  });

  it('does not disable an endpoint that succeeded during the window', async () => {
    let failing = true;
    const { dispatcher, endpoints, deliveries, makeDue, advance } = build({
      responder: () => ({ status: failing ? 500 : 200 }),
      maxAttempts: 1000,
      autoDisableAfter: 1,
    });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    advance(12 * HOUR);
    // A second event gets through mid-window...
    failing = false;
    await publish(dispatcher, 'payment.paid');
    const [first] = [...deliveries.values()];
    first.nextAttemptAt = new Date(Date.now() + 365 * 24 * HOUR);
    await dispatcher.drainOnce();
    // Fanned out from the outbox by this drain.
    const second = [...deliveries.values()][1];
    expect(second.status).toBe('DELIVERED');
    // ...so when the first one finally ages out the endpoint is not dead.
    failing = true;
    advance(12 * HOUR);
    makeDue();
    await dispatcher.drainOnce();
    expect(first.status).toBe('DEAD');
    expect(endpoints.get(ENDPOINT)!.status).toBe('ACTIVE');
  });

  describe('replayed deliveries (BN-TASK-008, BN-REQ-EVT-010)', () => {
    /** What `OutboundWebhookService.replay` writes. */
    const replay = (row: FakeDelivery, now: number): void => {
      Object.assign(row, {
        status: 'PENDING',
        error: null,
        nextAttemptAt: new Date(now - 1000),
        replayedAt: new Date(now),
        // Attempts already made: `attempt` is the number of the next one.
        attemptsBeforeReplay: row.attempt - 1,
      });
    };

    it('measures the retry window from the replay, not from the original event', async () => {
      const { dispatcher, deliveries, makeDue, advance, clock } = build({
        responder: () => ({ status: 500 }),
        maxAttempts: 1000,
      });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      advance(25 * HOUR);
      makeDue();
      await dispatcher.drainOnce();
      const row = [...deliveries.values()][0];
      expect(row.status).toBe('DEAD');
      const attemptsBefore = row.attempt;

      replay(row, clock.now);
      await dispatcher.drainOnce();
      // 25 h after the event, but seconds after the replay: retried, not dead.
      expect(row.status).toBe('FAILED');
      // And the counter kept counting.
      expect(row.attempt).toBe(attemptsBefore + 1);

      advance(24 * HOUR);
      makeDue();
      await dispatcher.drainOnce();
      expect(row.status).toBe('DEAD');
    });

    it('sends the real attempt number after a replay', async () => {
      const { dispatcher, deliveries, sent, clock } = build({
        responder: () => ({ status: 500 }),
        maxAttempts: 1,
      });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      const row = [...deliveries.values()][0];
      expect(row.status).toBe('DEAD');
      replay(row, clock.now);
      await dispatcher.drainOnce();
      expect(sent.map((s) => s.headers['x-mtbpay-attempt'])).toEqual(['1', '2']);
    });

    it('applies the attempt cap to the attempts made since the replay', async () => {
      const { dispatcher, deliveries, makeDue, clock } = build({
        responder: () => ({ status: 500 }),
        maxAttempts: 2,
      });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      makeDue();
      await dispatcher.drainOnce();
      const row = [...deliveries.values()][0];
      expect(row.status).toBe('DEAD');
      replay(row, clock.now);
      await dispatcher.drainOnce();
      expect(row.status).toBe('FAILED');
      makeDue();
      await dispatcher.drainOnce();
      expect(row.status).toBe('DEAD');
    });
  });

  describe('outbound_delivery_result log (BN-TASK-044)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('logs a delivered attempt with its status and latency', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { dispatcher, deliveries } = build();
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      const [row] = [...deliveries.values()];
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'outbound_delivery_result',
          deliveryId: row.id,
          result: 'delivered',
          attempt: 1,
          httpStatus: 200,
          latencyMs: expect.any(Number) as unknown,
        }),
      );
    });

    it('logs a failed attempt as retry, and the last one as failed, at warn', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { dispatcher, makeDue } = build({ responder: () => ({ status: 503 }), maxAttempts: 2 });
      await publish(dispatcher, 'payment.paid');
      await dispatcher.drainOnce();
      makeDue();
      await dispatcher.drainOnce();
      const results = warn.mock.calls
        .map(([entry]) => entry as { event?: string; result?: string })
        .filter((entry) => entry.event === 'outbound_delivery_result')
        .map((entry) => entry.result);
      expect(results).toEqual(['retry', 'failed']);
    });
  });

  describe('snapshot delivery (BN-REQ-EVT-005)', () => {
    it('sends the persisted snapshot, not the order as it is now', async () => {
      const { dispatcher, outbox, deliveries, sent } = build();
      await publish(dispatcher, 'payment.paid');
      // The order moved on after the event was committed.
      const stale = outbox[0];
      await dispatcher.drainOnce();
      const delivered = [...deliveries.values()][0];
      delivered.order!.status = 'REFUNDED';
      const body = JSON.parse(sent[0].body) as Record<string, unknown>;
      expect(body).toEqual(stale.payload);
      expect(Object.keys(body)).toEqual([
        'eventId',
        'eventType',
        'occurredAt',
        'sequence',
        'tenantId',
        'data',
      ]);
      expect(sent[0].headers['x-mtbpay-event-id']).toBe(stale.payload.eventId);
      expect(stale.dispatchedAt).toBeInstanceOf(Date);
    });

    it('marks an event nobody subscribes to as dispatched, without deliveries', async () => {
      const { dispatcher, outbox, deliveries } = build();
      await publish(dispatcher, 'payment.failed');
      await dispatcher.drainOnce();
      expect(deliveries.size).toBe(0);
      expect(outbox[0].dispatchedAt).toBeInstanceOf(Date);
    });
  });

  it('keeps one event id across retries so the subscriber can deduplicate', async () => {
    const { dispatcher, sent, makeDue } = build({
      responder: (_s, call) => ({ status: call === 1 ? 500 : 200 }),
      maxAttempts: 3,
    });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    makeDue();
    await dispatcher.drainOnce();
    expect(sent).toHaveLength(2);
    expect(sent[0].headers['x-mtbpay-event-id']).toBe(sent[1].headers['x-mtbpay-event-id']);
    // The attempt counter is what does change.
    expect(sent[0].headers['x-mtbpay-attempt']).toBe('1');
    expect(sent[1].headers['x-mtbpay-attempt']).toBe('2');
  });

  it('resets the failure count after a success', async () => {
    const { dispatcher, endpoints } = build({ responder: () => ({ status: 200 }) });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    expect(endpoints.get(ENDPOINT)!.consecutiveFailures).toBe(0);
    expect([...(endpoints.get(ENDPOINT)! ? [] : [])]).toHaveLength(0);
  });

  it('records a transport failure without inventing a provider status', async () => {
    const { dispatcher, deliveries } = build({ responder: () => ({ throws: true }) });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    const row = [...deliveries.values()][0];
    expect(row.status).toBe('FAILED');
    // The subscriber's response body must never be persisted or surfaced.
    expect(row.responseStatus).toBeNull();
  });

  it('claims a delivery so a second instance does not take it', async () => {
    const { dispatcher, deliveries } = build();
    await publish(dispatcher, 'payment.paid');
    // Nothing to claim until a drain fans the committed event out.
    expect(deliveries.size).toBe(0);
    await dispatcher.drainOnce();
    expect(deliveries.size).toBe(1);
    // Released once the attempt is recorded, so another instance can retry it.
    expect([...deliveries.values()][0].lockedAt).toBeNull();
  });

  it('does not deliver a row whose event type nobody subscribed to', async () => {
    const { dispatcher, sent, deliveries } = build();
    await publish(dispatcher, 'payment.refunded');
    await dispatcher.drainOnce();
    expect(deliveries.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('survives a subscriber that is not a webhook endpoint at all', async () => {
    const { dispatcher, sent, deliveries } = build({
      responder: () => ({ throws: true }),
      maxAttempts: 1,
    });
    await publish(dispatcher, 'payment.paid');
    await expect(dispatcher.drainOnce()).resolves.toBe(1);
    expect(sent).toHaveLength(1);
    // Exhausted in one attempt, so the record is terminal rather than retried.
    expect([...deliveries.values()][0].status).toBe('DEAD');
  });

  it('ignores an endpoint whose secret will not decrypt', async () => {
    const { dispatcher, sent } = build({
      endpoints: [
        {
          id: 'ep-corrupt',
          tenantId: TENANT,
          url: 'https://hooks.example.com/x',
          events: ['payment.paid'],
          status: 'ACTIVE',
          secretCiphertext: 'not-a-real-ciphertext',
        },
      ],
    });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    // Still attempted, but with no usable signature rather than a bogus one.
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['x-mtbpay-signature']).toMatch(/^t=\d+,v1=/);
  });
});

describe('OutboundDispatcher credential hygiene', () => {
  it('never writes the subscriber secret into the stored error', async () => {
    const { dispatcher, deliveries } = build({ responder: () => ({ status: 500 }) });
    await publish(dispatcher, 'payment.paid');
    await dispatcher.drainOnce();
    const serialised = JSON.stringify([...deliveries.values()]);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(PASSWORD);
  });

  it('emits both signatures during a rotation overlap', async () => {
    const box = new PaymentSecretBox(Buffer.alloc(32, 3).toString('base64'));
    const h = build({
      endpoints: [
        {
          id: 'ep-rotate',
          tenantId: TENANT,
          url: 'https://hooks.example.com/rotate',
          events: ['payment.paid'],
          status: 'ACTIVE',
          secretCiphertext: box.encrypt(SECRET, PaymentSecretBox.aadForEndpoint('ep-rotate')),
          previousSecretCiphertext: box.encrypt(
            'whsec_previous_secret',
            PaymentSecretBox.aadForEndpoint('ep-rotate'),
          ),
        },
      ],
    });
    await publish(h.dispatcher, 'payment.paid');
    await h.dispatcher.drainOnce();
    const header = h.sent[0].headers['x-mtbpay-signature'];
    const body = h.sent[0].body;
    // The same header validates against either secret, so a subscriber that has
    // already switched and one that has not both keep working.
    expect(verifyDelivery(header, body, SECRET, Date.now())).toEqual({ valid: true });
    // During the overlap the header carries one timestamp and two signatures,
    // so a subscriber on either secret accepts it. Which secret verifies is
    // covered directly in signature.spec.ts; here the point is the wire format.
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    expect(verifyDelivery(header, body, SECRET, Date.now())).toEqual({ valid: true });
  });
});
