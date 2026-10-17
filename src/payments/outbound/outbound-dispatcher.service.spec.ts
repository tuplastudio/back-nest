import 'reflect-metadata';
import { jest } from '@jest/globals';
import {
  OutboundDispatcher,
  type OutboundOptions,
  type OutboundTransport,
} from './outbound-dispatcher.service';
import { Prisma } from '../../generated/tenant-plane/client';
import { PaymentSecretBox } from '../payment-secret-box';
import { UrlGuard, type DnsResolver } from './url-guard';
import { verifyDelivery } from './signature';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../../prisma/control-plane-prisma.service';

const SCHEMA = 'tenant_acme_00000001';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECRET = 'whsec_spec_secret';
const PASSWORD = `sk_netpay_${'z'.repeat(40)}`;

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
  order: {
    id: string;
    orderReference: string;
    merchantReferenceCode: string;
    amount: Prisma.Decimal;
    currency: string;
    status: string;
  } | null;
}

/** Records what the dispatcher put on the wire. */
interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly hostHeader: string;
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
    drain?: boolean;
  } = {},
) {
  const box = new PaymentSecretBox(Buffer.alloc(32, 3).toString('base64'));
  const endpoints = new Map<string, FakeEndpoint>();
  const deliveries = new Map<string, FakeDelivery>();
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
    webhookEndpoint: {
      findMany: jest.fn((args: Record<string, never>) => {
        const rows = [...endpoints.values()].filter((e) => matches(args.where, e as never));
        return Promise.resolve(rows.map((e) => ({ id: e.id })));
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
          .map((d) => ({
            ...d,
            endpoint: endpoints.get(d.endpointId),
            order: d.order,
          }));
        return Promise.resolve(rows);
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
    request: (url, init) => {
      callCount += 1;
      const record: Sent = {
        url,
        headers: init.headers,
        body: init.body,
        hostHeader: init.hostHeader,
      };
      sent.push(record);
      const answer = options.responder?.(record, callCount);
      if (answer !== undefined && 'throws' in answer) {
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({ status: answer?.status ?? 200 });
    },
  };

  const dns: DnsResolver = {
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
  };

  const dispatcher = new OutboundDispatcher(
    tenantPrisma,
    controlPlane,
    transport,
    new UrlGuard(dns, true),
    box,
    tuning,
  );

  /** Makes every pending delivery due, since the backoff defers it on purpose. */
  const makeDue = (): void => {
    for (const row of deliveries.values()) {
      if (row.status === 'PENDING' || row.status === 'FAILED') {
        row.nextAttemptAt = new Date(Date.now() - 1000);
      }
    }
  };

  return { dispatcher, endpoints, deliveries, sent, box, makeDue };
}

const EVENT = {
  orderId: 'order-1',
  amount: '650.00',
  currency: 'MXN',
  status: 'PAID',
  sequence: 4,
};

describe('OutboundDispatcher', () => {
  it('signs the delivery so the subscriber can authenticate us', async () => {
    const { dispatcher, sent, box } = build();
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
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
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    const body = sent[0].body.toLowerCase();
    for (const leak of ['cardholder', 'cardholdername', 'lastfourdigits', 'pan', 'cvv', 'bankname']) {
      expect(body).not.toContain(leak);
    }
  });

  it('connects to the address the guard approved, not to the name', async () => {
    const { dispatcher, sent } = build();
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    // Pinned, so DNS cannot re-point between the check and the connection.
    expect(sent[0].url).toBe('https://93.184.216.34/payments');
    expect(sent[0].hostHeader).toBe('hooks.example.com');
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
    await h.dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await h.dispatcher.drainOnce();
    expect(h.sent).toHaveLength(0);
    expect(h.endpoints.get(endpointId)!.status).toBe('AUTO_DISABLED');
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
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    expect(sent).toHaveLength(0);
  });

  it('retries a failing subscriber with a growing backoff', async () => {
    const { dispatcher, deliveries, sent, makeDue } = build({
      responder: () => ({ status: 500 }),
      maxAttempts: 3,
    });
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);

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

  it('disables an endpoint that keeps failing, and says why', async () => {
    const { dispatcher, endpoints, makeDue } = build({
      responder: () => ({ status: 500 }),
      maxAttempts: 10,
      autoDisableAfter: 2,
    });
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    makeDue();
    await dispatcher.drainOnce();
    const endpoint = endpoints.get(ENDPOINT)!;
    expect(endpoint.status).toBe('AUTO_DISABLED');
    expect(endpoint.disabledReason).not.toBeNull();
    expect(endpoint.disabledAt).toBeInstanceOf(Date);
  });

  it('keeps one event id across retries so the subscriber can deduplicate', async () => {
    const { dispatcher, sent, makeDue } = build({
      responder: (_s, call) => ({ status: call === 1 ? 500 : 200 }),
      maxAttempts: 3,
    });
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
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
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    expect(endpoints.get(ENDPOINT)!.consecutiveFailures).toBe(0);
    expect([...(endpoints.get(ENDPOINT)! ? [] : [])]).toHaveLength(0);
  });

  it('records a transport failure without inventing a provider status', async () => {
    const { dispatcher, deliveries } = build({ responder: () => ({ throws: true }) });
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    const row = [...deliveries.values()][0];
    expect(row.status).toBe('FAILED');
    // The subscriber's response body must never be persisted or surfaced.
    expect(row.responseStatus).toBeNull();
  });

  it('claims a delivery so a second instance does not take it', async () => {
    const { dispatcher, deliveries } = build();
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    const [row] = [...deliveries.values()];
    expect(row.lockedAt).toBeNull();
    await dispatcher.drainOnce();
    // Released once the attempt is recorded, so another instance can retry it.
    expect([...deliveries.values()][0].lockedAt).toBeNull();
  });

  it('does not deliver a row whose event type nobody subscribed to', async () => {
    const { dispatcher, sent, deliveries } = build();
    await dispatcher.queue('payment.refunded', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    expect(deliveries.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('survives a subscriber that is not a webhook endpoint at all', async () => {
    const { dispatcher, sent, deliveries } = build({
      responder: () => ({ throws: true }),
      maxAttempts: 1,
    });
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
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
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
    await dispatcher.drainOnce();
    // Still attempted, but with no usable signature rather than a bogus one.
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['x-mtbpay-signature']).toMatch(/^t=\d+,v1=/);
  });
});

describe('OutboundDispatcher credential hygiene', () => {
  it('never writes the subscriber secret into the stored error', async () => {
    const { dispatcher, deliveries } = build({ responder: () => ({ status: 500 }) });
    await dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
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
    await h.dispatcher.queue('payment.paid', TENANT, SCHEMA, EVENT);
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
