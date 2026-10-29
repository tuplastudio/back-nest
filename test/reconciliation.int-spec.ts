import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { Prisma } from '../src/generated/tenant-plane/client';
import { TenantPrismaService } from '../src/prisma/tenant-prisma.service';
import { TenantSchemaNamingService } from '../src/tenancy/tenant-schema-naming.service';
import { RequestContextService } from '../src/tenancy/request-context.service';
import { PaymentEvents } from '../src/payments/payment-events';
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

import {
  ReconciliationService,
  type ReconcileOptions,
} from '../src/payments/reconciliation/reconciliation.service';
import { runTenantMigrations } from '../scripts/lib/tenant-migration-runner';
import type { NetpayClient } from '../src/payments/netpay.client';
import type { AppConfig } from '../src/config/app-config.service';
import type { AuditEntry, AuditLogService } from '../src/audit/audit-log.service';
import type { PaymentConfigService } from '../src/payments/payment-config.service';
import type { ControlPlanePrismaService } from '../src/prisma/control-plane-prisma.service';

/**
 * Reconciliation against a real PostgreSQL (BN-TASK-016, BN-REQ-REC-001…004) and the
 * late payment on a cancelled order (BN-TASK-018, BN-REQ-PAY-004).
 *
 * Netpay is a stand-in that answers `GET /v3/transactions/{id}` from a map; each test
 * backdates its orders past the minimum age so the worker picks them up. The data
 * plane connects as a login role in `mtb_app`, so forced RLS, the grants and the
 * `FOR UPDATE SKIP LOCKED` lease run as in production.
 *
 * Locally:
 *   TENANT_MIGRATIONS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55438/postgres npm run test:int
 */
const ADMIN_URL =
  process.env['TENANT_MIGRATIONS_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:55438/postgres';
const ROOT = process.cwd();
const RUN = randomBytes(4).toString('hex');
const DATABASE = `bn_reconcile_${RUN}`;
const APP_ROLE = `bn_reconcile_app_${RUN}`;
const APP_PASSWORD = randomBytes(12).toString('hex');
const SCHEMA = `tenant_reconcile_${RUN}`;
const TENANT_ID = randomUUID();
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
const MINUTE = 60_000;

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

const OPTIONS: ReconcileOptions = {
  enabled: true,
  intervalMs: 0,
  minAgeMs: 5 * MINUTE,
  batchSize: 50,
  leaseMs: 5 * MINUTE,
  threeDsTimeoutMs: 30 * MINUTE,
  chargeUnknownGraceMs: 60 * MINUTE,
  providerRatePerSecond: 1000,
  lateWindowMs: 24 * 60 * MINUTE,
};

describe('reconciliation (BN-TASK-016, integration)', () => {
  const requestContext = new RequestContextService();
  const naming = new TenantSchemaNamingService();
  let tenantPrisma: TenantPrismaService;

  /** Netpay stand-in: transaction id → what GET answers. Calls are `get:<key>:<id>`. */
  const transactions = new Map<string, { status: string; amount: number; merchantReferenceCode?: string }>();
  const calls: string[] = [];
  const netpay = {
    getTransaction: async (_env: string, key: string, id: string) => {
      calls.push(`get:${key}:${id}`);
      // A little latency, so two workers really overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const tx = transactions.get(id);
      if (tx === undefined) {
        throw new Error('not found');
      }
      // Like Netpay: the transaction names the order it was charged for.
      const bound = await tenantPrisma.forTenantTransaction(SCHEMA, (client) =>
        client.paymentOrder.findFirst({
          where: { netpayTransactionId: id },
          select: { orderReference: true },
        }),
      );
      return { transactionTokenId: id, merchantReferenceCode: bound?.orderReference, ...tx };
    },
  } as unknown as NetpayClient;
  /** Two configuration versions: orders of v1 must be checked with v1's key. */
  const CONFIG_V1 = randomUUID();
  const CONFIG_V2 = randomUUID();
  const paymentConfig = {
    getUsableInSchema: (_schema: string, configId?: string | null) =>
      Promise.resolve({
        id: configId ?? CONFIG_V2,
        environment: 'SANDBOX',
        secretKey: configId === CONFIG_V1 ? 'sk_netpay_v1' : 'sk_netpay_v2',
      }),
  } as unknown as PaymentConfigService;
  const audits: AuditEntry[] = [];
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;
  const controlPlane = {
    client: {
      tenant: {
        findMany: () => Promise.resolve([{ id: TENANT_ID, schemaName: SCHEMA }]),
      },
    },
  } as unknown as ControlPlanePrismaService;

  const orders = () =>
    new PaymentOrdersService(
      tenantPrisma,
      requestContext,
      paymentConfig,
      netpay,
      new PaymentEvents(),
      audit,
      quickLinks,
    );
  const worker = (options: Partial<ReconcileOptions> = {}) =>
    new ReconciliationService(controlPlane, tenantPrisma, orders(), { ...OPTIONS, ...options });

  /** Inserts an order, last touched `ageMs` ago. */
  async function seed(
    data: Partial<Prisma.PaymentOrderUncheckedCreateInput> & { ageMs: number },
  ): Promise<string> {
    const { ageMs, ...rest } = data;
    const at = new Date(Date.now() - ageMs);
    const row = await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.create({
        data: {
          tenantId: TENANT_ID,
          orderReference: `rec_${randomBytes(6).toString('hex')}`,
          merchantReferenceCode: 'INT-REC',
          amount: new Prisma.Decimal('100.00'),
          currency: 'MXN',
          status: 'PENDING',
          checkoutMode: 'custom',
          createdAt: at,
          updatedAt: at,
          ...rest,
        },
        select: { id: true },
      }),
    );
    return row.id;
  }

  async function attempt(orderId: string, tx: string | null, status: string, ageMs: number): Promise<void> {
    await tenantPrisma.forTenantTransaction(SCHEMA, (client) =>
      client.paymentAttempt.create({
        data: {
          id: randomUUID(),
          orderId,
          attemptNo: 1,
          netpayTransactionId: tx,
          status,
          createdAt: new Date(Date.now() - ageMs),
        },
      }),
    );
  }

  const orderOf = (id: string) =>
    tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.findFirstOrThrow({
        where: { id },
        select: {
          status: true,
          netpayTransactionId: true,
          operationClaim: true,
          refundedAmount: true,
          paidAfterCancelAt: true,
          reconcileLeaseUntil: true,
          updatedAt: true,
        },
      }),
    );
  const eventsOf = async (id: string) =>
    (
      await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
        tx.paymentEventOutbox.findMany({ where: { orderId: id }, orderBy: { sequence: 'asc' } }),
      )
    ).map((e) => e.eventType);
  const attemptsOf = (id: string) =>
    tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentAttempt.findMany({ where: { orderId: id }, select: { status: true } }),
    );
  const getsFor = (tx: string) => calls.filter((c) => c.endsWith(`:${tx}`)).length;

  beforeAll(async () => {
    expect(naming.isValidSchemaName(SCHEMA)).toBe(true);
    await withClient(ADMIN_URL, async (admin) => {
      await admin.query(`CREATE DATABASE "${DATABASE}"`);
      for (const role of ['mtb_control', 'mtb_app']) {
        await admin.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
        );
      }
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
        [TENANT_ID, `reconcile-${RUN}`, SCHEMA],
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
  });

  afterAll(async () => {
    await tenantPrisma?.onModuleDestroy();
    await withClient(ADMIN_URL, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    audits.length = 0;
    // Each test starts from orders it seeds itself.
    await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.updateMany({
        where: {},
        data: { reconcileLeaseUntil: new Date(Date.now() + 24 * 60 * MINUTE) },
      }),
    );
  });

  it('settles a PENDING order Netpay reports paid, without a webhook, and emits payment.paid', async () => {
    const tx = `txn_paid_${RUN}`;
    transactions.set(tx, { status: 'DONE', amount: 100 });
    const id = await seed({ netpayTransactionId: tx, ageMs: 10 * MINUTE });

    const summary = await worker().runOnce();

    expect(await orderOf(id)).toMatchObject({ status: 'PAID', operationClaim: null });
    expect(await eventsOf(id)).toEqual(['payment.paid']);
    expect(summary).toMatchObject({ tenants: 1, checked: 1, corrected: 1, errors: 0 });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'payment.status_changed',
        metadata: expect.objectContaining({
          from: 'PENDING',
          to: 'PAID',
          source: 'reconciliation',
        }) as unknown,
      }),
    ]);
  });

  it('leaves an order younger than the minimum age alone', async () => {
    const tx = `txn_young_${RUN}`;
    transactions.set(tx, { status: 'DONE', amount: 100 });
    const id = await seed({ netpayTransactionId: tx, ageMs: MINUTE });

    await worker().runOnce();

    expect((await orderOf(id)).status).toBe('PENDING');
    expect(getsFor(tx)).toBe(0);
  });

  it('expires a charge left in WAIT_THREEDS for more than 30 min and emits payment.expired', async () => {
    const tx = `txn_3ds_${RUN}`;
    transactions.set(tx, { status: 'WAIT_THREEDS', amount: 100 });
    const id = await seed({ netpayTransactionId: tx, status: 'PENDING_VERIFICATION', ageMs: 40 * MINUTE });
    await attempt(id, tx, 'SUBMITTED', 40 * MINUTE);

    await worker().runOnce();

    expect((await orderOf(id)).status).toBe('EXPIRED');
    expect(await eventsOf(id)).toEqual(['payment.expired']);
    expect(await attemptsOf(id)).toEqual([{ status: 'ABANDONED' }]);
  });

  it('keeps a WAIT_THREEDS charge younger than 30 min pending, without rewriting it', async () => {
    const tx = `txn_3ds_young_${RUN}`;
    transactions.set(tx, { status: 'WAIT_THREEDS', amount: 100 });
    const id = await seed({ netpayTransactionId: tx, status: 'PENDING_VERIFICATION', ageMs: 10 * MINUTE });
    await attempt(id, tx, 'SUBMITTED', 10 * MINUTE);
    const before = (await orderOf(id)).updatedAt;

    await worker().runOnce();

    const after = await orderOf(id);
    expect(after.status).toBe('PENDING_VERIFICATION');
    expect(after.updatedAt).toEqual(before);
    expect(getsFor(tx)).toBe(1);
  });

  it('expires an unpaid cash reference past its expiry (BN-REQ-REC-003)', async () => {
    const id = await seed({
      checkoutMode: 'oxxo',
      paymentMethod: 'OXXO',
      paymentReference: `9201${RUN}`,
      paymentReferenceExpiresAt: new Date(Date.now() - 20 * MINUTE),
      ageMs: 3 * 24 * 60 * MINUTE,
    });

    await worker().runOnce();

    expect((await orderOf(id)).status).toBe('EXPIRED');
    expect(await eventsOf(id)).toEqual(['payment.expired']);
  });

  it('settles a cash reference that was paid before it expired instead of expiring it', async () => {
    const tx = `txn_oxxo_paid_${RUN}`;
    transactions.set(tx, { status: 'DONE', amount: 100 });
    const id = await seed({
      checkoutMode: 'oxxo',
      paymentMethod: 'OXXO',
      paymentReference: `9202${RUN}`,
      netpayTransactionId: tx,
      paymentReferenceExpiresAt: new Date(Date.now() - 20 * MINUTE),
      ageMs: 3 * 24 * 60 * MINUTE,
    });

    await worker().runOnce();

    expect((await orderOf(id)).status).toBe('PAID');
    expect(await eventsOf(id)).toEqual(['payment.paid']);
  });

  it('returns a CHARGE_UNKNOWN order with no transaction to PENDING after the grace period', async () => {
    const id = await seed({
      status: 'CHARGE_UNKNOWN',
      operationClaim: 'charge',
      operationClaimedAt: new Date(Date.now() - 90 * MINUTE),
      ageMs: 90 * MINUTE,
    });
    await attempt(id, null, 'UNKNOWN', 90 * MINUTE);

    await worker().runOnce();

    expect(await orderOf(id)).toMatchObject({
      status: 'PENDING',
      operationClaim: null,
      netpayTransactionId: null,
    });
    // PENDING is not subscriber-visible: no event.
    expect(await eventsOf(id)).toEqual([]);
    expect(await attemptsOf(id)).toEqual([{ status: 'UNRESOLVED' }]);
  });

  it('keeps a CHARGE_UNKNOWN order inside the grace period', async () => {
    const id = await seed({ status: 'CHARGE_UNKNOWN', operationClaim: 'charge', ageMs: 10 * MINUTE });
    await attempt(id, null, 'UNKNOWN', 10 * MINUTE);

    await worker().runOnce();

    expect((await orderOf(id)).status).toBe('CHARGE_UNKNOWN');
  });

  it('completes a refund whose outcome was unknown when Netpay reports the charge cancelled', async () => {
    const tx = `txn_refund_${RUN}`;
    transactions.set(tx, { status: 'CANCELED', amount: 100 });
    const id = await seed({
      status: 'PAID',
      netpayTransactionId: tx,
      operationClaim: 'refund',
      operationClaimedAt: new Date(Date.now() - 10 * MINUTE),
      ageMs: 10 * MINUTE,
    });

    await worker().runOnce();

    const row = await orderOf(id);
    expect(row).toMatchObject({ status: 'REFUNDED', operationClaim: null });
    expect(row.refundedAmount.toFixed(2)).toBe('100.00');
    expect(await eventsOf(id)).toEqual(['payment.refunded']);
  });

  it('records a payment Netpay reports for a CANCELLED order without reopening it (BN-TASK-018)', async () => {
    const tx = `txn_late_${RUN}`;
    transactions.set(tx, { status: 'DONE', amount: 100 });
    const id = await seed({ status: 'CANCELLED', netpayTransactionId: tx, ageMs: 10 * MINUTE });

    await worker().runOnce();

    const row = await orderOf(id);
    expect(row.status).toBe('CANCELLED');
    expect(row.paidAfterCancelAt).not.toBeNull();
    expect(await eventsOf(id)).toEqual(['payment.paid_after_cancel']);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'payment.paid_after_cancel',
          resourceId: id,
          metadata: expect.objectContaining({ outcome: 'LATE_PAYMENT_ON_CANCELLED' }) as unknown,
        }),
      ]),
    );

    // Once recorded, never again.
    await tenantPrisma.forTenantTransaction(SCHEMA, (client) =>
      client.paymentOrder.update({ where: { id }, data: { reconcileLeaseUntil: null } }),
    );
    await worker().runOnce();
    expect(await eventsOf(id)).toEqual(['payment.paid_after_cancel']);
  });

  it('checks an old order with the configuration it was created with (BN-REQ-CFG-002)', async () => {
    const tx = `txn_v1_${RUN}`;
    transactions.set(tx, { status: 'DONE', amount: 100 });
    const id = await seed({ netpayTransactionId: tx, configId: null, ageMs: 10 * MINUTE });
    await tenantPrisma.forTenantTransaction(SCHEMA, (client) =>
      client.paymentProviderConfig.create({
        data: {
          id: CONFIG_V1,
          tenantId: TENANT_ID,
          environment: 'SANDBOX',
          publicKey: 'pk_netpay_v1',
          secretKeyCiphertext: 'x',
          orderReferencePrefix: 'rec',
          webhookTokenHash: 'a'.repeat(64),
          version: 1,
          active: false,
        },
      }),
    );
    await tenantPrisma.forTenantTransaction(SCHEMA, (client) =>
      client.paymentOrder.update({
        where: { id },
        data: { configId: CONFIG_V1, updatedAt: new Date(Date.now() - 10 * MINUTE) },
      }),
    );

    await worker().runOnce();

    expect(calls).toContain(`get:sk_netpay_v1:${tx}`);
    expect((await orderOf(id)).status).toBe('PAID');
  });

  it('checks each order once when two workers run at the same time (BN-REQ-REC-004)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const tx = `txn_pair_${RUN}_${i}`;
      transactions.set(tx, { status: 'DONE', amount: 100 });
      ids.push(await seed({ netpayTransactionId: tx, ageMs: 10 * MINUTE }));
    }

    const [a, b] = await Promise.all([worker().runOnce(), worker().runOnce()]);

    for (let i = 0; i < 6; i += 1) {
      expect(getsFor(`txn_pair_${RUN}_${i}`)).toBe(1);
    }
    expect(a.checked + b.checked).toBe(6);
    for (const id of ids) {
      expect(await eventsOf(id)).toEqual(['payment.paid']);
    }
  });

  it('applies pending provider results first (BN-REQ-IDM-004)', async () => {
    const id = await seed({
      status: 'PAID',
      netpayTransactionId: `txn_pending_${RUN}`,
      operationClaim: 'refund',
      ageMs: MINUTE,
    });
    await tenantPrisma.forTenantTransaction(SCHEMA, (client) =>
      client.pendingProviderResult.create({
        data: {
          id: randomUUID(),
          orderId: id,
          operation: 'refund',
          providerPayload: {
            kind: 'refund',
            transactionId: `txn_pending_${RUN}`,
            amount: '100.00',
            refundedAmountBefore: '0.00',
          },
          createdAt: new Date(),
        },
      }),
    );

    const summary = await worker().runOnce();

    expect(summary.pendingApplied).toBe(1);
    expect((await orderOf(id)).status).toBe('REFUNDED');
  });
});
