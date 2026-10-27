import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
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
} as unknown as PaymentQuickLinksService;

import { NetpayTransportError, type NetpayClient } from '../src/payments/netpay.client';
import { IdempotencyStore } from '../src/common/idempotency/idempotency.store';
import { runTenantMigrations } from '../scripts/lib/tenant-migration-runner';
import type { AppConfig } from '../src/config/app-config.service';
import type { AuditLogService } from '../src/audit/audit-log.service';
import type { PaymentConfigService } from '../src/payments/payment-config.service';
import type { TenantContext } from '../src/tenancy/tenant-context.interface';

/**
 * Recovery paths of the money-moving operations against a real PostgreSQL:
 *
 *  * BN-TASK-011 (BN-REQ-IDM-004) — Netpay confirms and the local write fails: the
 *    result waits in `pending_provider_result`, the claim holds, and
 *    `applyPendingProviderResults` applies it exactly once;
 *  * BN-TASK-014 (BN-REQ-PAY-003) — a charge without a definitive answer leaves the
 *    order CHARGE_UNKNOWN until a verification resolves it;
 *  * BN-TASK-015 (BN-REQ-PAY-001) — attempts are numbered per order;
 *  * BN-TASK-010 (BN-REQ-IDM-001/003) — the idempotency store decides the owner of a
 *    key in the database, under concurrency.
 *
 * The data plane connects as a login role in `mtb_app`, so forced RLS and the
 * grants of the new tables are exercised as in production.
 *
 * Locally:
 *   docker run -d --name bn-e2e-w3 -p 127.0.0.1:55438:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
 *   TENANT_MIGRATIONS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55438/postgres npm run test:int
 */
const ADMIN_URL =
  process.env['TENANT_MIGRATIONS_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:55438/postgres';
const ROOT = process.cwd();
const RUN = randomBytes(4).toString('hex');
const DATABASE = `bn_recovery_${RUN}`;
const APP_ROLE = `bn_recovery_app_${RUN}`;
const APP_PASSWORD = randomBytes(12).toString('hex');
const SCHEMA = `tenant_recovery_${RUN}`;
const TENANT_ID = randomUUID();
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

const BILLING = {
  firstName: 'Ana',
  lastName: 'Lopez',
  email: 'ana@example.mx',
  phone: '5512345678',
  address: { city: 'Monterrey', country: 'MX', postalCode: '65700', state: 'NLE', street1: 'Filosofos 100' },
};
const DEVICE = {
  deviceFingerPrint: 'fp_0123456789abcdef',
  deviceInformation: {
    deviceChannel: 'Browser',
    httpBrowserColorDepth: '24',
    httpBrowserJavaEnabled: 'FALSE',
    httpBrowserJavaScriptEnabled: 'TRUE',
    httpBrowserLanguage: 'es',
    httpBrowserScreenHeight: '687',
    httpBrowserScreenWidth: '1718',
    httpBrowserTimeDifference: '360',
  },
};

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

/** Fails the transaction that writes an event of the given type: the "local write fails". */
class FailingEvents extends PaymentEvents {
  constructor(private readonly failOn: string) {
    super();
  }

  override async record(tx: OutboxClient, input: RecordEventInput): Promise<PaymentEventPayload> {
    if (input.eventType === this.failOn) {
      throw new Error(`database write failed while recording ${input.eventType}`);
    }
    return super.record(tx, input);
  }
}

describe('payment recovery paths (BN-TASK-010/011/014/015, integration)', () => {
  const requestContext = new RequestContextService();
  const naming = new TenantSchemaNamingService();
  let tenantPrisma: TenantPrismaService;
  const tenant: TenantContext = {
    id: TENANT_ID,
    slug: `recovery-${RUN}`,
    name: 'Recovery',
    schemaName: SCHEMA,
    status: 'ACTIVE',
    plan: 'standard',
    timezone: 'UTC',
    locale: 'es',
    resolvedAt: Date.now(),
  };

  /** Netpay stand-in; each test sets what it needs. */
  const calls: string[] = [];
  const transactions = new Map<string, { status: string; amount: number }>();
  let nextCharge: () => Promise<Record<string, unknown>> = () =>
    Promise.resolve({ transactionTokenId: 'unset', status: 'success' });
  const netpay = {
    getTransaction: (_env: string, _key: string, id: string) => {
      calls.push(`get:${id}`);
      const tx = transactions.get(id) ?? { status: 'DONE', amount: 100 };
      return Promise.resolve({ transactionTokenId: id, ...tx });
    },
    refund: () => {
      calls.push('refund');
      return Promise.resolve();
    },
    cancelCharge: () => {
      calls.push('cancel');
      return Promise.resolve('CANCELED');
    },
    createClient: () => Promise.resolve({ id: `cus_${randomBytes(3).toString('hex')}` }),
    deleteCard: () => Promise.resolve(),
    createCharge: () => {
      calls.push('charge');
      return nextCharge();
    },
  } as unknown as NetpayClient;
  const paymentConfig = {
    getUsable: () => Promise.resolve({ id: null, environment: 'SANDBOX', secretKey: 'sk_netpay_int' }),
    getUsableInSchema: () =>
      Promise.resolve({ id: null, environment: 'SANDBOX', secretKey: 'sk_netpay_int' }),
  } as unknown as PaymentConfigService;
  const audit = { record: () => Promise.resolve() } as unknown as AuditLogService;

  const service = (events: PaymentEvents = new PaymentEvents()) =>
    new PaymentOrdersService(tenantPrisma, requestContext, paymentConfig, netpay, events, audit, quickLinks);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run({ tenant }, fn);

  async function newOrder(): Promise<{ id: string; orderReference: string }> {
    return tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.create({
        data: {
          tenantId: TENANT_ID,
          orderReference: `rec_${randomBytes(6).toString('hex')}`,
          merchantReferenceCode: 'INT-REC',
          amount: new Prisma.Decimal('100.00'),
          currency: 'MXN',
          status: 'PENDING',
          checkoutMode: 'custom',
        },
        select: { id: true, orderReference: true },
      }),
    );
  }

  const orderOf = (id: string) =>
    tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentOrder.findFirstOrThrow({
        where: { id },
        select: {
          status: true,
          refundedAmount: true,
          operationClaim: true,
          netpayTransactionId: true,
          failureCode: true,
        },
      }),
    );
  const pendingOf = (id: string) =>
    tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.pendingProviderResult.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } }),
    );
  const eventsOf = (id: string) =>
    tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentEventOutbox.findMany({ where: { orderId: id }, orderBy: { sequence: 'asc' } }),
    );
  const attemptsOf = (id: string) =>
    tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
      tx.paymentAttempt.findMany({
        where: { orderId: id },
        orderBy: { attemptNo: 'asc' },
        select: { attemptNo: true, netpayTransactionId: true, status: true, declineCode: true },
      }),
    );

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
  });

  afterAll(async () => {
    await tenantPrisma?.onModuleDestroy();
    await withClient(ADMIN_URL, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  describe('pending provider results (BN-TASK-011)', () => {
    it('keeps a confirmed refund whose local write failed, holds the claim, and applies it once', async () => {
      const order = await newOrder();
      await service().verifyOrderInSchema(SCHEMA, order.id, `txn_ref_${RUN}`, TENANT_ID);

      await expect(
        inTenant(() => service(new FailingEvents('payment.refunded')).refund(order.id, 'injected')),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESULT_PENDING' });
      expect(calls.filter((c) => c === 'cancel' || c === 'refund')).toHaveLength(1);

      // Netpay reversed it; the order does not say so yet, and the claim holds.
      let row = await orderOf(order.id);
      expect(row.status).toBe('PAID');
      expect(row.refundedAmount.toFixed(2)).toBe('0.00');
      expect(row.operationClaim).toBe('refund');
      const [pending] = await pendingOf(order.id);
      expect(pending).toMatchObject({ operation: 'refund', appliedAt: null });

      // Even after the claim window, a second refund cannot claim the order.
      await tenantPrisma.forTenantTransaction(SCHEMA, (tx) =>
        tx.paymentOrder.update({
          where: { id: order.id },
          data: { operationClaimedAt: new Date(Date.now() - 60 * 60_000) },
        }),
      );
      await expect(inTenant(() => service().refund(order.id))).rejects.toMatchObject({ status: 409 });
      expect(calls.filter((c) => c === 'cancel' || c === 'refund')).toHaveLength(1);

      // Reconciliation applies it, once, even when two runs race.
      const runs = await Promise.all([
        service().applyPendingProviderResults(tenant),
        service().applyPendingProviderResults(tenant),
      ]);
      expect(runs.reduce((sum, r) => sum + r.applied, 0)).toBe(1);
      row = await orderOf(order.id);
      expect(row.status).toBe('REFUNDED');
      expect(row.refundedAmount.toFixed(2)).toBe('100.00');
      expect(row.operationClaim).toBeNull();
      expect((await pendingOf(order.id))[0].appliedAt).not.toBeNull();
      expect((await eventsOf(order.id)).map((e) => e.eventType)).toEqual([
        'payment.paid',
        'payment.refunded',
      ]);

      const again = await service().applyPendingProviderResults(tenant);
      expect(again.applied).toBe(0);
      expect((await eventsOf(order.id)).map((e) => e.eventType)).toEqual([
        'payment.paid',
        'payment.refunded',
      ]);
    });

    it('keeps a declined charge whose local write failed, and applies the decline once', async () => {
      const order = await newOrder();
      nextCharge = () =>
        Promise.resolve({
          transactionTokenId: `txn_decl_${RUN}`,
          status: 'failed',
          declineReason: 'Fondos insuficientes',
          failureCode: 'INSUFFICIENT_FUNDS',
          providerFailureCode: '51',
        });
      await expect(
        inTenant(() =>
          service(new FailingEvents('payment.failed')).chargeToken(order.id, {
            cardToken: 'token_abcdefghijklmnop',
            billing: BILLING,
            ...DEVICE,
          }),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESULT_PENDING' });
      expect((await orderOf(order.id)).operationClaim).toBe('charge');
      expect((await pendingOf(order.id))[0]).toMatchObject({ operation: 'charge', appliedAt: null });

      const result = await service().applyPendingProviderResults(tenant);
      expect(result.applied).toBe(1);
      const row = await orderOf(order.id);
      expect(row).toMatchObject({
        status: 'FAILED',
        failureCode: 'INSUFFICIENT_FUNDS',
        operationClaim: null,
        netpayTransactionId: `txn_decl_${RUN}`,
      });
      expect(await attemptsOf(order.id)).toEqual([
        {
          attemptNo: 1,
          netpayTransactionId: `txn_decl_${RUN}`,
          status: 'FAILED',
          declineCode: 'INSUFFICIENT_FUNDS',
        },
      ]);
      expect((await eventsOf(order.id)).map((e) => e.eventType)).toEqual(['payment.failed']);
      expect((await service().applyPendingProviderResults(tenant)).applied).toBe(0);
    });
  });

  describe('CHARGE_UNKNOWN and attempts (BN-TASK-014, BN-TASK-015)', () => {
    it('leaves a charge that timed out CHARGE_UNKNOWN, refuses new charges, and resolves on verify', async () => {
      const order = await newOrder();
      nextCharge = () =>
        Promise.reject(new NetpayTransportError('/v3.5/charges/', new Error('socket hang up')));
      const charge = () =>
        inTenant(() =>
          service().chargeToken(order.id, {
            cardToken: 'token_abcdefghijklmnop',
            billing: BILLING,
            ...DEVICE,
          }),
        );
      await expect(charge()).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', status: 504 });
      expect((await orderOf(order.id)).status).toBe('CHARGE_UNKNOWN');
      expect(await attemptsOf(order.id)).toEqual([
        { attemptNo: 1, netpayTransactionId: null, status: 'UNKNOWN', declineCode: null },
      ]);

      calls.length = 0;
      await expect(charge()).rejects.toMatchObject({
        code: 'ORDER_STATE_CONFLICT',
        status: 409,
        details: { status: 'CHARGE_UNKNOWN' },
      });
      expect(calls).not.toContain('charge');

      // The transaction turned up (Netpay Manager, or the notification): verify settles it.
      const tx = `txn_found_${RUN}`;
      transactions.set(tx, { status: 'DONE', amount: 100 });
      const verified = await service().verifyOrderInSchema(SCHEMA, order.id, tx, TENANT_ID);
      expect(verified.status).toBe('PAID');
      expect(await attemptsOf(order.id)).toEqual([
        { attemptNo: 1, netpayTransactionId: tx, status: 'PAID', declineCode: null },
      ]);
      const [paid] = await eventsOf(order.id);
      expect((paid.payload as { data: Record<string, unknown> }).data).toMatchObject({
        status: 'PAID',
        previousStatus: 'CHARGE_UNKNOWN',
        netpayTransactionId: tx,
      });
    });

    it('accepts a new attempt once verify finds the unknown charge declined', async () => {
      const order = await newOrder();
      nextCharge = () => Promise.reject(new NetpayTransportError('/v3.5/charges/', new Error('timeout')));
      const charge = () =>
        inTenant(() =>
          service().chargeToken(order.id, {
            cardToken: 'token_abcdefghijklmnop',
            billing: BILLING,
            ...DEVICE,
          }),
        );
      await expect(charge()).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' });
      const lost = `txn_lost_${RUN}`;
      transactions.set(lost, { status: 'REJECT', amount: 100 });
      expect((await service().verifyOrderInSchema(SCHEMA, order.id, lost, TENANT_ID)).status).toBe('FAILED');

      const second = `txn_second_${RUN}`;
      transactions.set(second, { status: 'DONE', amount: 100 });
      nextCharge = () => Promise.resolve({ transactionTokenId: second, status: 'success', amount: 100 });
      const result = await charge();
      expect(result.orderStatus).toBe('PAID');
      expect((await attemptsOf(order.id)).map((a) => [a.attemptNo, a.netpayTransactionId, a.status])).toEqual(
        [
          [1, lost, 'FAILED'],
          [2, second, 'PAID'],
        ],
      );
    });
  });

  describe('idempotency store (BN-TASK-010)', () => {
    const store = () => new IdempotencyStore(tenantPrisma);

    it('lets exactly one of two concurrent requests own a key, then replays, refuses another body and expires', async () => {
      const key = `key-${RUN}`;
      const route = 'POST /api/v1/t/payments/orders/x/refund';
      const [a, b] = await Promise.all([
        store().begin(SCHEMA, key, route, 'a'.repeat(64)),
        store().begin(SCHEMA, key, route, 'a'.repeat(64)),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['in_progress', 'owner']);

      await store().complete(SCHEMA, key, route, 200, { kind: 'success', body: { status: 'REFUNDED' } });
      expect(await store().begin(SCHEMA, key, route, 'a'.repeat(64))).toEqual({
        kind: 'replay',
        status: 200,
        response: { kind: 'success', body: { status: 'REFUNDED' } },
      });
      expect((await store().begin(SCHEMA, key, route, 'b'.repeat(64))).kind).toBe('reused');

      // A day later the key is free again.
      const later = new Date(Date.now() + 25 * 60 * 60_000);
      expect((await store().begin(SCHEMA, key, route, 'b'.repeat(64), later)).kind).toBe('owner');
    });

    it('keeps a 5xx key in progress for ten minutes', async () => {
      const key = `key5-${RUN}`;
      const route = 'POST /api/v1/t/payments/orders/y/charge';
      expect((await store().begin(SCHEMA, key, route, 'c'.repeat(64))).kind).toBe('owner');
      await store().holdInProgress(SCHEMA, key, route, 504);
      expect((await store().begin(SCHEMA, key, route, 'c'.repeat(64))).kind).toBe('in_progress');
      const later = new Date(Date.now() + 11 * 60_000);
      expect((await store().begin(SCHEMA, key, route, 'c'.repeat(64), later)).kind).toBe('owner');
    });
  });
});
