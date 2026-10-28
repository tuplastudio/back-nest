import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { z } from 'zod';
import { Prisma } from '../src/generated/tenant-plane/client';
import { TenantPrismaService } from '../src/prisma/tenant-prisma.service';
import { TenantSchemaNamingService } from '../src/tenancy/tenant-schema-naming.service';
import { RequestContextService } from '../src/tenancy/request-context.service';
import {
  PaymentEvents,
  type OutboxClient,
  type PaymentEventPayload,
  type RecordEventInput,
} from '../src/payments/payment-events';
import { PaymentOrdersService } from '../src/payments/payment-orders.service';
import type { PaymentQuickLinksService } from '../src/payments/payment-quick-links.service';

const quickLinks = {
  enabled: () => false,
  newCode: () => 'ABCDEF',
  returnUrls: () => ({ successUrl: '', cancelUrl: '' }),
  register: () => Promise.resolve({ code: 'ABCDEF', url: '' }),
  findForOrder: () => Promise.resolve(null),
  findForOrders: () => Promise.resolve(new Map()),
} as unknown as PaymentQuickLinksService;
import { PaymentSecretBox } from '../src/payments/payment-secret-box';
import {
  OutboundDispatcher,
  type OutboundTransport,
} from '../src/payments/outbound/outbound-dispatcher.service';
import { UrlGuard } from '../src/payments/outbound/url-guard';
import { verifyDelivery } from '../src/payments/outbound/signature';
import { runTenantMigrations } from '../scripts/lib/tenant-migration-runner';
import type { AppConfig } from '../src/config/app-config.service';
import type { AuditLogService } from '../src/audit/audit-log.service';
import type { ControlPlanePrismaService } from '../src/prisma/control-plane-prisma.service';
import type { NetpayClient } from '../src/payments/netpay.client';
import type { PaymentConfigService } from '../src/payments/payment-config.service';
import type { TenantContext } from '../src/tenancy/tenant-context.interface';

/**
 * Transactional outbox against a real PostgreSQL (BN-TASK-004, BN-REQ-EVT-004/005/006).
 *
 * The data plane connects as a login role that is a member of `mtb_app`, so the
 * forced row-level security and the grants of the new table are exercised as in
 * production. Each run creates and drops its own database and role.
 *
 * Locally:
 *   docker run -d --name bn-e2e-w2 -p 127.0.0.1:55437:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
 *   TENANT_MIGRATIONS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55437/postgres npm run test:int
 */
const ADMIN_URL =
  process.env['TENANT_MIGRATIONS_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:55436/postgres';
const ROOT = process.cwd();
const RUN = randomBytes(4).toString('hex');
const DATABASE = `bn_outbox_${RUN}`;
const APP_ROLE = `bn_outbox_app_${RUN}`;
const APP_PASSWORD = randomBytes(12).toString('hex');
const SCHEMA = `tenant_outbox_${RUN}`;
const TENANT_ID = randomUUID();
const ENDPOINT_ID = randomUUID();
const SIGNING_SECRET = 'whsec_outbox_integration';
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** What the subscriber received. */
interface Received {
  readonly headers: Record<string, string>;
  readonly body: string;
}

describe('payment event outbox (BN-TASK-004, integration)', () => {
  const box = new PaymentSecretBox(randomBytes(32).toString('base64'));
  const requestContext = new RequestContextService();
  const naming = new TenantSchemaNamingService();
  let tenantPrisma: TenantPrismaService;
  const tenant: TenantContext = {
    id: TENANT_ID,
    slug: `outbox-${RUN}`,
    name: 'Outbox',
    schemaName: SCHEMA,
    status: 'ACTIVE',
    plan: 'standard',
    timezone: 'UTC',
    locale: 'es',
    resolvedAt: Date.now(),
  };

  /** Netpay stand-in: every transaction is settled for the amount asked. */
  const netpay = {
    getTransaction: (_env: string, _key: string, id: string) =>
      Promise.resolve({ transactionTokenId: id, status: 'DONE', amount: 100 }),
    refund: () => Promise.resolve(),
    cancelCharge: () => Promise.resolve('CANCELED'),
  } as unknown as NetpayClient;
  const paymentConfig = {
    getUsable: () => Promise.resolve({ id: null, environment: 'SANDBOX', secretKey: 'sk_netpay_int' }),
    getUsableInSchema: () =>
      Promise.resolve({ id: null, environment: 'SANDBOX', secretKey: 'sk_netpay_int' }),
  } as unknown as PaymentConfigService;
  const audit = { record: () => Promise.resolve() } as unknown as AuditLogService;

  const service = (events: PaymentEvents = new PaymentEvents()) =>
    new PaymentOrdersService(tenantPrisma, requestContext, paymentConfig, netpay, events, audit, quickLinks);

  /** A fresh dispatcher: what a restarted process would build. */
  function dispatcher(received: Received[]): OutboundDispatcher {
    const transport: OutboundTransport = {
      request: (_destination, init) => {
        received.push({ headers: init.headers, body: init.body });
        return Promise.resolve({ status: 200 });
      },
    };
    const controlPlane = {
      client: {
        tenant: {
          findMany: (args: { where: { id?: unknown } }) =>
            Promise.resolve(args.where.id === undefined ? [{ id: TENANT_ID, schemaName: SCHEMA }] : []),
        },
      },
    } as unknown as ControlPlanePrismaService;
    const guard = new UrlGuard({ lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) });
    return new OutboundDispatcher(tenantPrisma, controlPlane, transport, guard, box, {
      maxAttempts: 10,
      baseBackoffMs: 1000,
      maxBackoffMs: 3_600_000,
      jitterMs: 0,
      timeoutMs: 5000,
      pollIntervalMs: 0,
      batchSize: 50,
      autoDisableAfter: 5,
      maxTenantsPerTick: 10,
      maxAgeMs: 24 * 3_600_000,
      concurrency: 4,
    });
  }

  async function newOrder(): Promise<{ id: string; orderReference: string }> {
    return tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.create({
        data: {
          tenantId: TENANT_ID,
          orderReference: `outbox_${randomBytes(6).toString('hex')}`,
          merchantReferenceCode: 'INT-1',
          amount: new Prisma.Decimal('100.00'),
          currency: 'MXN',
          status: 'PENDING',
          checkoutMode: 'custom',
        },
        select: { id: true, orderReference: true },
      }),
    );
  }

  async function outboxOf(orderId: string) {
    return tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentEventOutbox.findMany({ where: { orderId }, orderBy: { sequence: 'asc' } }),
    );
  }

  async function statusOf(orderId: string): Promise<string> {
    const row = await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.findFirstOrThrow({ where: { id: orderId }, select: { status: true } }),
    );
    return row.status;
  }

  beforeAll(async () => {
    expect(naming.isValidSchemaName(SCHEMA)).toBe(true);
    await withClient(ADMIN_URL, async (admin) => {
      await admin.query(`CREATE DATABASE "${DATABASE}"`);
      for (const role of ['mtb_control', 'mtb_app']) {
        await admin.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
        );
      }
      // A login of its own, member of mtb_app: never touches mtb_app's password,
      // which the e2e step of the same CI job relies on.
      await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE mtb_app`);
    });
    await withClient(urlFor(DATABASE), async (client) => {
      const root = join(ROOT, 'prisma', 'migrations');
      for (const name of readdirSync(root)
        .filter((n) => /^\d{14}_/.test(n))
        .sort()) {
        await client.query(readFileSync(join(root, name, 'migration.sql'), 'utf8'));
      }
      await client.query(`CREATE SCHEMA "${SCHEMA}"`);
      await client.query(
        `INSERT INTO "tenants" ("id", "slug", "name", "schemaName", "status", "updatedAt")
         VALUES ($1, $2, $2, $3, 'ACTIVE'::"TenantStatus", now())`,
        [TENANT_ID, tenant.slug, SCHEMA],
      );
    });
    await runTenantMigrations({
      connectionString: urlFor(DATABASE),
      migrationsDir: join(ROOT, 'prisma', 'tenant-migrations'),
      logger: silent,
    });
    tenantPrisma = new TenantPrismaService(
      {
        tenantDatabaseUrl: urlFor(DATABASE, { name: APP_ROLE, password: APP_PASSWORD }),
        databasePoolMax: 5,
        databasePoolIdleTimeoutMs: 1000,
        databaseConnectionTimeoutMs: 5000,
        databaseStatementTimeoutMs: 10_000,
      } as AppConfig,
      naming,
      requestContext,
    );
    await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.webhookEndpoint.create({
        data: {
          id: ENDPOINT_ID,
          tenantId: TENANT_ID,
          url: 'https://hooks.example.com/payments',
          secretCiphertext: box.encrypt(SIGNING_SECRET, PaymentSecretBox.aadForEndpoint(ENDPOINT_ID)),
          events: ['payment.paid', 'payment.refunded'],
          updatedAt: new Date(),
        },
      }),
    );
  });

  afterAll(async () => {
    await tenantPrisma?.onModuleDestroy();
    await withClient(ADMIN_URL, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    });
  });

  it('leaves no event when the transaction that changed the order rolls back', async () => {
    const order = await newOrder();
    /** Writes the event, then fails the transaction it was written in. */
    class FailingAfterWrite extends PaymentEvents {
      override async record(tx: OutboxClient, input: RecordEventInput): Promise<PaymentEventPayload> {
        await super.record(tx, input);
        throw new Error('crash after the event write');
      }
    }
    await expect(
      service(new FailingAfterWrite()).verifyOrderInSchema(SCHEMA, order.id, 'txn_rollback', TENANT_ID),
    ).rejects.toThrow('crash after the event write');

    expect(await statusOf(order.id)).toBe('PENDING');
    expect(await outboxOf(order.id)).toHaveLength(0);
  });

  it('delivers, after a restart, an event committed before the process died, as its snapshot', async () => {
    const order = await newOrder();
    // Commit PAID and its event. No dispatcher is running: the process "dies" here.
    const result = await service().verifyOrderInSchema(SCHEMA, order.id, 'txn_restart', TENANT_ID);
    expect(result.status).toBe('PAID');
    const [paid] = await outboxOf(order.id);
    expect(paid).toMatchObject({ sequence: 1, eventType: 'payment.paid', dispatchedAt: null });

    // The order moves on before anything is delivered.
    await requestContext.run({ tenant }, () => service().refund(order.id, 'partial', '30.00'));
    expect(await statusOf(order.id)).toBe('PARTIALLY_REFUNDED');

    // "Restart": a brand-new dispatcher finds both committed events.
    const received: Received[] = [];
    await dispatcher(received).drainOnce();

    const bodies = received
      .map((r) => ({
        ...r,
        json: JSON.parse(r.body) as Record<string, unknown> & { data: Record<string, unknown> },
      }))
      .sort((a, b) => Number(a.json['sequence']) - Number(b.json['sequence']));
    expect(bodies).toHaveLength(2);
    // The snapshot of the change, not a rebuild from the order's current row.
    expect(bodies[0].json).toEqual(paid.payload);
    expect(bodies[0].json.data['status']).toBe('PAID');
    expect(bodies[0].json.data['previousStatus']).toBe('PENDING');
    expect(bodies[0].json['occurredAt']).toBe(paid.occurredAt.toISOString());
    expect(bodies[0].headers['x-mtbpay-event-id']).toBe((paid.payload as { eventId: string }).eventId);
    expect(
      verifyDelivery(
        bodies[0].headers['x-mtbpay-signature'] ?? '',
        bodies[0].body,
        SIGNING_SECRET,
        Date.now(),
      ),
    ).toEqual({ valid: true });
    expect(bodies[1].json.data['status']).toBe('PARTIALLY_REFUNDED');
    // What reached the subscriber validates against the published contract (BN-REQ-EVT-011).
    for (const { json } of bodies) {
      const file = join(ROOT, 'docs', 'events', `${String(json['eventType'])}.schema.json`);
      const schema = z.fromJSONSchema(
        JSON.parse(readFileSync(file, 'utf8')) as Parameters<typeof z.fromJSONSchema>[0],
      );
      expect(schema.safeParse(json).error?.issues ?? []).toEqual([]);
    }

    const after = await outboxOf(order.id);
    expect(after.every((row) => row.dispatchedAt !== null)).toBe(true);
    const deliveries = await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.webhookDelivery.findMany({ where: { orderId: order.id }, select: { status: true, outboxId: true } }),
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'DELIVERED' && d.outboxId !== null)).toBe(true);

    // A second drain delivers nothing again.
    const again: Received[] = [];
    await dispatcher(again).drainOnce();
    expect(again).toHaveLength(0);
  });

  it('gives a partial refund sequence + 1 and its refundedAmount, then REFUNDED for the rest', async () => {
    const order = await newOrder();
    await service().verifyOrderInSchema(SCHEMA, order.id, 'txn_partial', TENANT_ID);
    await requestContext.run({ tenant }, () => service().refund(order.id, 'partial', '30.00'));
    await requestContext.run({ tenant }, () => service().refund(order.id, 'rest'));

    const events = await outboxOf(order.id);
    expect(events.map((e) => [e.sequence, e.eventType])).toEqual([
      [1, 'payment.paid'],
      [2, 'payment.refunded'],
      [3, 'payment.refunded'],
    ]);
    const partial = events[1].payload as { sequence: number; data: Record<string, unknown> };
    expect(partial.sequence).toBe(2);
    expect(partial.data).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      previousStatus: 'PAID',
      refundedAmount: '30.00',
      refunded: '30.00',
      fullyRefunded: false,
    });
    const full = events[2].payload as { data: Record<string, unknown> };
    expect(full.data).toMatchObject({
      status: 'REFUNDED',
      previousStatus: 'PARTIALLY_REFUNDED',
      refundedAmount: '100.00',
      refunded: '70.00',
      fullyRefunded: true,
    });
    expect(await statusOf(order.id)).toBe('REFUNDED');
  });

  it('fans an event out once even when two dispatchers race for it', async () => {
    const order = await newOrder();
    await service().verifyOrderInSchema(SCHEMA, order.id, 'txn_race', TENANT_ID);
    const received: Received[] = [];
    await Promise.all([dispatcher(received).drainOnce(), dispatcher(received).drainOnce()]);
    const deliveries = await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.webhookDelivery.findMany({ where: { orderId: order.id } }),
    );
    expect(deliveries).toHaveLength(1);
  });
});
