import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Prisma } from '../generated/tenant-plane/client';
import { PaymentOrdersService } from './payment-orders.service';
import { PaymentSecretBox } from './payment-secret-box';
import { PaymentGatewaysService } from './gateways/payment-gateways.service';
import { NotFoundException } from '../common/errors/app.exception';
import type { NetpayClient } from './netpay.client';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentEvents, RecordEventInput } from './payment-events';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { AuditLogService } from '../audit/audit-log.service';
import type { PaymentQuickLinksService } from './payment-quick-links.service';
import type { AppConfig } from '../config/app-config.service';
import type { ConfigService } from '@nestjs/config';

/**
 * Alternative gateways end to end inside back-nest (docs 33): what each gateway is
 * sent (fetch is mocked, nothing leaves the process) and what is written back
 * through the shared verification. The tenant database is an in-memory fake.
 */

const SCHEMA = 'tenant_acme_00000001';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const REF = 'VND_ref1';

type Row = Record<string, unknown>;

function orderRow(over: Row = {}): Row {
  return {
    id: 'order-1',
    sequence: 1,
    orderReference: REF,
    merchantReferenceCode: 'PLANE-1',
    amount: new Prisma.Decimal('100.50'),
    currency: 'MXN',
    status: 'PENDING',
    netpayTransactionId: null,
    amountToken: null,
    failureReason: null,
    checkoutMode: 'hosted',
    paymentMethod: null,
    paymentReference: null,
    paymentReferenceExpiresAt: null,
    refundedAmount: new Prisma.Decimal('0'),
    provider: 'STRIPE',
    checkoutSessionId: 'cs_1',
    createdAt: new Date('2026-10-31T00:00:00Z'),
    updatedAt: new Date('2026-10-31T00:00:00Z'),
    ...over,
  };
}

/** One recorded call to the mocked `fetch`. */
interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fixture(
  rows: Row[],
  options: {
    routes?: (sent: Sent) => [number, unknown];
    /** Stripe platform-account mode: no Connect client id. */
    platformMode?: boolean;
    /** The route the control plane already holds for the account. */
    existingRoute?: { tenantId: string; revokedAt: Date | null };
    /** A live key without a client id: platform mode refused. */
    refusedLiveKey?: boolean;
  } = {},
) {
  const box = new PaymentSecretBox(randomBytes(32).toString('base64'));
  const accounts = new Map<string, Row>();
  const writes: Row[] = [];
  const emitted: string[] = [];
  const routes: Row[] = [];
  const revoked: { where: Row; data: Row }[] = [];
  const sent: Sent[] = [];
  const answers: [number, unknown][] = [];

  const merge = (data: Row): Row => {
    const merged: Row = { ...(rows[0] ?? {}) };
    for (const [k, v] of Object.entries(data)) {
      const inc = typeof v === 'object' && v !== null && 'increment' in v ? v.increment : undefined;
      merged[k] =
        inc === undefined
          ? v
          : merged[k] instanceof Prisma.Decimal
            ? merged[k].plus(inc as Prisma.Decimal)
            : Number(merged[k] ?? 0) + Number(inc);
    }
    rows[0] = merged;
    return merged;
  };
  const client = {
    paymentOrder: {
      findFirst: () => Promise.resolve(rows[0] ?? null),
      findFirstOrThrow: () => Promise.resolve(rows[0]),
      updateMany: () => Promise.resolve({ count: 1 }),
      update: (args: { data: Row }) => {
        writes.push(args.data);
        return Promise.resolve(merge(args.data));
      },
      create: (args: { data: Row }) => {
        writes.push(args.data);
        rows[0] = orderRow({ ...args.data, id: 'order-new', checkoutSessionId: null });
        return Promise.resolve(rows[0]);
      },
    },
    paymentAttempt: {
      updateMany: () => Promise.resolve({ count: 1 }),
      findFirst: () => Promise.resolve(null),
      create: () => Promise.resolve({}),
    },
    paymentGatewayAccount: {
      findUnique: (args: { where: { provider: string } }) =>
        Promise.resolve(accounts.get(args.where.provider) ?? null),
      findMany: () => Promise.resolve([...accounts.values()]),
      upsert: (args: { where: { provider: string }; create: Row; update: Row }) => {
        const prev = accounts.get(args.where.provider);
        accounts.set(
          args.where.provider,
          prev === undefined ? { ...args.create } : { ...prev, ...args.update },
        );
        return Promise.resolve({});
      },
      update: (args: { where: { provider: string }; data: Row }) => {
        accounts.set(args.where.provider, { ...accounts.get(args.where.provider), ...args.data });
        return Promise.resolve({});
      },
      updateMany: () => Promise.resolve({ count: 1 }),
    },
  };
  const tenantPrisma = {
    requireCurrentSchema: () => SCHEMA,
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => Promise.resolve(cb(client)),
    forTenantTransaction: (_s: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const controlPlane = {
    client: {
      tenant: { findUnique: () => Promise.resolve({ schemaName: SCHEMA, status: 'ACTIVE' }) },
      paymentGatewayRoute: {
        findUnique: () => Promise.resolve(options.existingRoute ?? null),
        updateMany: (args: { where: Row; data: Row }) => {
          revoked.push(args);
          return Promise.resolve({ count: 0 });
        },
        upsert: (args: { create: Row }) => {
          routes.push(args.create);
          return Promise.resolve({});
        },
      },
    },
  } as unknown as ControlPlanePrismaService;
  const tenant = { id: TENANT_ID, schemaName: SCHEMA };
  const requestContext = {
    get: () => ({ tenant, principal: { kind: 'api-key', id: 'k', tenantId: TENANT_ID, scopes: [] } }),
    requireTenant: () => tenant,
  } as unknown as RequestContextService;
  const config = {
    // No Netpay configuration at all: gateway orders must not need one.
    getCurrent: () => Promise.reject(new NotFoundException('none')),
    getUsable: () => Promise.reject(new Error('Netpay must not be asked about a gateway order')),
  } as unknown as PaymentConfigService;
  const app = {
    paymentGateways: {
      stripe:
        options.refusedLiveKey === true
          ? null
          : {
              secretKey: 'sk_test_platform',
              clientId: options.platformMode === true ? null : 'ca_123',
              webhookSecret: 'whsec_x',
            },
      stripePlatformModeRefused: options.refusedLiveKey === true,
      mercadoPago: {
        clientId: '123',
        clientSecret: 'mp-client-secret-x',
        webhookSecret: 'mp-webhook-secret-x',
      },
      returnOrigins: ['https://vondi.tupla.dev'],
    },
    publicBaseUrl: 'https://api.example.com',
    apiPrefix: 'api/v1',
  } as unknown as AppConfig;
  const gateways = new PaymentGatewaysService(tenantPrisma, controlPlane, requestContext, box, config, app, {
    getOrThrow: () => randomBytes(32).toString('base64'),
  } as unknown as ConfigService);
  const events = {
    record: (_tx: unknown, input: RecordEventInput) => {
      emitted.push(input.eventType);
      return Promise.resolve({});
    },
  } as unknown as PaymentEvents;
  const quickLinks = { enabled: () => false } as unknown as PaymentQuickLinksService;
  const audit = { record: () => Promise.resolve() } as unknown as AuditLogService;
  const service = new PaymentOrdersService(
    tenantPrisma,
    requestContext,
    config,
    {} as NetpayClient,
    events,
    audit,
    quickLinks,
    gateways,
  );

  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const call: Sent = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    sent.push(call);
    const [status, body] = answers.shift() ?? options.routes?.(call) ?? [200, {}];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });

  return {
    service,
    gateways,
    box,
    accounts,
    writes,
    emitted,
    routes,
    revoked,
    sent,
    rows,
    /** Queues the next gateway answers, in order. */
    answer: (...next: [number, unknown][]) => answers.push(...next),
    connect: (provider: string, row: Row = {}) =>
      accounts.set(provider, {
        provider,
        externalAccountId:
          provider === 'STRIPE' ? 'acct_123' : provider === 'OPENPAY' ? 'mabcdefghij1234567890' : '777',
        environment: 'SANDBOX',
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        tokenExpiresAt: null,
        publicKey: null,
        webhookId: null,
        connectedAt: new Date(),
        disconnectedAt: null,
        ...row,
      }),
  };
}

const form = (body: string | undefined): URLSearchParams => new URLSearchParams(body ?? '');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Stripe orders', () => {
  it('creates a Checkout Session on the connected account: cents, metadata and saveCard flags', async () => {
    const f = fixture([]);
    f.connect('STRIPE');
    f.answer([200, { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' }]);

    const view = await f.service.create({
      merchantReferenceCode: 'PLANE-9',
      amount: '100.50',
      provider: 'STRIPE',
      saveCard: true,
    });

    expect(f.sent).toHaveLength(1);
    const [call] = f.sent;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call.headers['Stripe-Account']).toBe('acct_123');
    expect(call.headers['Authorization']).toBe('Bearer sk_test_platform');
    expect(call.headers['Idempotency-Key']).toBe('bn-checkout-order-new');
    const body = form(call.body);
    const reference = String(f.writes[0]?.['orderReference']);
    expect(reference).toMatch(/^VND_/);
    expect(body.get('mode')).toBe('payment');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('10050');
    expect(body.get('line_items[0][price_data][currency]')).toBe('mxn');
    expect(body.get('metadata[bn_order_reference]')).toBe(reference);
    expect(body.get('payment_intent_data[metadata][bn_order_reference]')).toBe(reference);
    expect(body.get('customer_creation')).toBe('always');
    expect(body.get('payment_intent_data[setup_future_usage]')).toBe('off_session');
    expect(view.provider).toBe('STRIPE');
    expect(view.checkout).toMatchObject({
      provider: 'STRIPE',
      hostedCheckoutUrl: 'https://checkout.stripe.com/c/pay/cs_new',
      publicKey: '',
      environment: 'SANDBOX',
    });
    expect(f.writes).toContainEqual(expect.objectContaining({ checkoutSessionId: 'cs_new' }));
  });

  it('refuses saveCard outside Stripe hosted and a gateway that is not connected', async () => {
    const f = fixture([]);
    await expect(
      f.service.create({
        merchantReferenceCode: 'X',
        amount: '1.00',
        provider: 'MERCADOPAGO',
        saveCard: true,
      }),
    ).rejects.toThrow(/saveCard/);
    await expect(
      f.service.create({ merchantReferenceCode: 'X', amount: '1.00', provider: 'STRIPE' }),
    ).rejects.toMatchObject({ code: 'GATEWAY_NOT_CONNECTED', status: 409 });
  });

  const session = (intent: Record<string, unknown>) => ({
    id: 'cs_1',
    customer: 'cus_1',
    payment_intent: {
      id: 'pi_1',
      status: 'succeeded',
      amount: 10050,
      currency: 'mxn',
      metadata: { bn_order_reference: REF },
      setup_future_usage: 'off_session',
      payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242' } },
      ...intent,
    },
  });

  it('verifies through the session: succeeded ⇒ PAID, binds pi_… and keeps the saved card', async () => {
    const f = fixture([orderRow()]);
    f.connect('STRIPE');
    f.answer([200, session({})]);

    const result = await f.service.verifyGatewayOrder('order-1', null);

    expect(f.sent[0]?.url).toContain('/v1/checkout/sessions/cs_1?expand[]=payment_intent');
    expect(result.status).toBe('PAID');
    expect(f.emitted).toContain('payment.paid');
    expect(f.rows[0]).toMatchObject({
      netpayTransactionId: 'pi_1',
      gatewayCustomerId: 'cus_1',
      gatewayPaymentMethodId: 'pm_1',
      gatewayCardBrand: 'visa',
      gatewayCardLast4: '4242',
    });
  });

  it('never pays on a different amount: AMOUNT_MISMATCH', async () => {
    const f = fixture([orderRow()]);
    f.connect('STRIPE');
    f.answer([200, session({ amount: 9999 })]);
    const result = await f.service.verifyGatewayOrder('order-1', null);
    expect(result.status).toBe('AMOUNT_MISMATCH');
    expect(f.rows[0]?.['gatewayCustomerId']).toBeUndefined();
  });

  it('refuses a payment that names another order', async () => {
    const f = fixture([orderRow()]);
    f.connect('STRIPE');
    f.answer([200, session({ metadata: { bn_order_reference: 'VND_other' } })]);
    await expect(f.service.verifyGatewayOrder('order-1', null)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows[0]?.['status']).toBe('PENDING');
  });

  it('refunds through POST /v1/refunds with cents and a key naming this exact refund', async () => {
    const f = fixture([orderRow({ status: 'PAID', netpayTransactionId: 'pi_1' })]);
    f.connect('STRIPE');
    f.answer([200, { id: 're_1', status: 'succeeded' }]);

    const result = await f.service.refund('order-1', 'Refund', '40.00');

    expect(f.sent[0]?.url).toBe('https://api.stripe.com/v1/refunds');
    expect(f.sent[0]?.headers['Idempotency-Key']).toBe('bn-refund-order-1-0.00-40.00');
    expect(form(f.sent[0]?.body).get('payment_intent')).toBe('pi_1');
    expect(form(f.sent[0]?.body).get('amount')).toBe('4000');
    expect(result).toEqual({ status: 'PARTIALLY_REFUNDED', refundedAmount: '40.00', refunded: '40.00' });
  });

  it('charges a saved card off_session without the Netpay MIT flag and settles PAID', async () => {
    const f = fixture([orderRow({ checkoutMode: 'custom', checkoutSessionId: null })]);
    f.connect('STRIPE');
    f.answer([
      200,
      { id: 'pi_9', status: 'succeeded', amount: 10050, metadata: { bn_order_reference: REF } },
    ]);

    const result = await f.service.chargeStoredGateway('order-1', {
      clientId: 'cus_1',
      cardToken: 'pm_1abcdef',
    });

    const body = form(f.sent[0]?.body);
    expect(f.sent[0]?.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(body.get('off_session')).toBe('true');
    expect(body.get('confirm')).toBe('true');
    expect(body.get('customer')).toBe('cus_1');
    expect(body.get('payment_method')).toBe('pm_1abcdef');
    expect(body.get('amount')).toBe('10050');
    expect(f.sent[0]?.headers['Idempotency-Key']).toBe('bn-charge-order-1-first');
    expect(result).toMatchObject({ transactionTokenId: 'pi_9', orderStatus: 'PAID' });
  });

  it('records a 402 decline as a FAILED order bound to the declined PaymentIntent', async () => {
    const f = fixture([orderRow({ checkoutMode: 'custom', checkoutSessionId: null })]);
    f.connect('STRIPE');
    f.answer([
      402,
      {
        error: {
          code: 'card_declined',
          payment_intent: {
            id: 'pi_9',
            status: 'requires_payment_method',
            amount: 10050,
            metadata: { bn_order_reference: REF },
            last_payment_error: {
              code: 'card_declined',
              decline_code: 'insufficient_funds',
              message: 'Declined',
            },
          },
        },
      },
    ]);
    const result = await f.service.chargeStoredGateway('order-1', {
      clientId: 'cus_1',
      cardToken: 'pm_1abcdef',
    });
    expect(result.orderStatus).toBe('FAILED');
    expect(f.rows[0]?.['netpayTransactionId']).toBe('pi_9');
  });
});

describe('Mercado Pago orders', () => {
  it('refunds with the seller token and X-Idempotency-Key', async () => {
    const f = fixture([orderRow({ provider: 'MERCADOPAGO', status: 'PAID', netpayTransactionId: '123456' })]);
    f.connect('MERCADOPAGO', {
      accessTokenCiphertext: f.box.encrypt(
        'APP_USR-seller',
        PaymentSecretBox.aadForGateway(TENANT_ID, 'MERCADOPAGO', 'access'),
      ),
      tokenExpiresAt: new Date(Date.now() + 100 * 86_400_000),
    });
    f.answer([201, { id: 9, status: 'approved' }]);

    await f.service.refund('order-1');

    expect(f.sent[0]?.url).toBe('https://api.mercadopago.com/v1/payments/123456/refunds');
    expect(f.sent[0]?.headers['Authorization']).toBe('Bearer APP_USR-seller');
    expect(f.sent[0]?.headers['X-Idempotency-Key']).toBe('bn-refund-order-1-0.00-100.50');
    expect(JSON.parse(f.sent[0]?.body ?? '{}')).toEqual({ amount: 100.5 });
  });

  it('refuses charge-stored with 409 GATEWAY_AUTOPAY_UNSUPPORTED and calls nobody', async () => {
    const f = fixture([orderRow({ provider: 'MERCADOPAGO' })]);
    await expect(
      f.service.chargeStoredGateway('order-1', { clientId: 'cus_1', cardToken: 'pm_1abcdef' }),
    ).rejects.toMatchObject({ code: 'GATEWAY_AUTOPAY_UNSUPPORTED', status: 409 });
    expect(f.sent).toHaveLength(0);
  });

  it('finds an approved payment by reference when nothing is bound yet', async () => {
    const f = fixture([orderRow({ provider: 'MERCADOPAGO', checkoutSessionId: 'pref-1' })]);
    f.connect('MERCADOPAGO', {
      accessTokenCiphertext: f.box.encrypt(
        'APP_USR-seller',
        PaymentSecretBox.aadForGateway(TENANT_ID, 'MERCADOPAGO', 'access'),
      ),
    });
    f.answer([
      200,
      {
        results: [
          { id: 2, status: 'rejected', transaction_amount: 100.5, external_reference: REF },
          { id: 3, status: 'approved', transaction_amount: 100.5, external_reference: REF },
        ],
      },
    ]);
    const result = await f.service.verifyGatewayOrder('order-1', null);
    expect(f.sent[0]?.url).toContain(`/v1/payments/search?external_reference=${REF}`);
    expect(result.status).toBe('PAID');
    expect(f.rows[0]?.['netpayTransactionId']).toBe('3');
  });
});

describe('Conekta orders', () => {
  const conekta = (f: ReturnType<typeof fixture>) =>
    f.connect('CONEKTA', {
      externalAccountId: 'key_public',
      accessTokenCiphertext: f.box.encrypt(
        'key_private',
        PaymentSecretBox.aadForGateway(TENANT_ID, 'CONEKTA', 'access'),
      ),
    });

  it('creates a HostedPayment order with the private key as Basic user', async () => {
    const f = fixture([]);
    conekta(f);
    f.answer([200, { id: 'ord_1', checkout: { url: 'https://pay.conekta.com/checkout/abc' } }]);

    const view = await f.service.create({
      merchantReferenceCode: 'PLANE-9',
      amount: '100.50',
      provider: 'CONEKTA',
    });

    const call = f.sent[0];
    expect(call?.url).toBe('https://api.conekta.io/orders');
    expect(call?.headers['Authorization']).toBe(`Basic ${Buffer.from('key_private:').toString('base64')}`);
    expect(call?.headers['Accept']).toBe('application/vnd.conekta-v2.1.0+json');
    const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      currency: 'MXN',
      line_items: [{ unit_price: 10050, quantity: 1 }],
      metadata: { bn_order_reference: f.writes[0]?.['orderReference'] },
      checkout: { type: 'HostedPayment', allowed_payment_methods: ['card', 'cash', 'bank_transfer'] },
    });
    expect(view.checkout?.hostedCheckoutUrl).toBe('https://pay.conekta.com/checkout/abc');
    expect(f.writes).toContainEqual(expect.objectContaining({ checkoutSessionId: 'ord_1' }));
  });

  it('verifies the order: paid ⇒ PAID, a wrong amount ⇒ AMOUNT_MISMATCH', async () => {
    for (const [amount, expected] of [
      [10050, 'PAID'],
      [100, 'AMOUNT_MISMATCH'],
    ] as const) {
      const f = fixture([orderRow({ provider: 'CONEKTA', checkoutSessionId: 'ord_1' })]);
      conekta(f);
      f.answer([
        200,
        {
          id: 'ord_1',
          payment_status: 'paid',
          amount,
          metadata: { bn_order_reference: REF },
          charges: { data: [{ id: 'ch_1' }] },
        },
      ]);
      const result = await f.service.verifyGatewayOrder('order-1', null);
      expect(f.sent[0]?.url).toBe('https://api.conekta.io/orders/ord_1');
      expect(result.status).toBe(expected);
    }
  });

  it('refunds per order in cents', async () => {
    const f = fixture([orderRow({ provider: 'CONEKTA', status: 'PAID', netpayTransactionId: 'ord_1' })]);
    conekta(f);
    f.answer([200, { id: 'ord_1' }]);
    await f.service.refund('order-1');
    expect(f.sent[0]?.url).toBe('https://api.conekta.io/orders/ord_1/refunds');
    expect(JSON.parse(f.sent[0]?.body ?? '{}')).toEqual({ amount: 10050, reason: 'requested_by_client' });
  });
});

describe('Openpay orders', () => {
  const MERCHANT = 'mabcdefghij1234567890';
  const openpay = (f: ReturnType<typeof fixture>) =>
    f.connect('OPENPAY', {
      accessTokenCiphertext: f.box.encrypt(
        'sk_private',
        PaymentSecretBox.aadForGateway(TENANT_ID, 'OPENPAY', 'access'),
      ),
    });

  it('creates a confirm=false card charge and sends the buyer to payment_method.url', async () => {
    const f = fixture([]);
    openpay(f);
    f.answer([
      200,
      {
        id: 'trabc123',
        status: 'charge_pending',
        payment_method: { url: 'https://sandbox-api.openpay.mx/pay/x' },
      },
    ]);

    const view = await f.service.create({
      merchantReferenceCode: 'PLANE-9',
      amount: '100.50',
      provider: 'OPENPAY',
      successUrl: 'https://vondi.tupla.dev/ok',
    });

    expect(f.sent[0]?.url).toBe(`https://sandbox-api.openpay.mx/v1/${MERCHANT}/charges`);
    expect(JSON.parse(f.sent[0]?.body ?? '{}')).toMatchObject({
      method: 'card',
      amount: 100.5,
      currency: 'MXN',
      order_id: f.writes[0]?.['orderReference'],
      confirm: 'false',
      redirect_url: 'https://vondi.tupla.dev/ok',
    });
    expect(view.checkout?.hostedCheckoutUrl).toBe('https://sandbox-api.openpay.mx/pay/x');
  });

  it('verifies the charge: completed with this order_id ⇒ PAID; another order_id ⇒ conflict', async () => {
    const f = fixture([orderRow({ provider: 'OPENPAY', checkoutSessionId: 'trabc123' })]);
    openpay(f);
    f.answer([200, { id: 'trabc123', status: 'completed', amount: 100.5, order_id: REF }]);
    expect((await f.service.verifyGatewayOrder('order-1', null)).status).toBe('PAID');

    const g = fixture([orderRow({ provider: 'OPENPAY', checkoutSessionId: 'trabc123' })]);
    openpay(g);
    g.answer([200, { id: 'trabc123', status: 'completed', amount: 100.5, order_id: 'VND_other' }]);
    await expect(g.service.verifyGatewayOrder('order-1', null)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refunds the charge', async () => {
    const f = fixture([orderRow({ provider: 'OPENPAY', status: 'PAID', netpayTransactionId: 'trabc123' })]);
    openpay(f);
    f.answer([200, { id: 'trrefund' }]);
    await f.service.refund('order-1', 'Refund', '10.00');
    expect(f.sent[0]?.url).toBe(`https://sandbox-api.openpay.mx/v1/${MERCHANT}/charges/trabc123/refund`);
    expect(JSON.parse(f.sent[0]?.body ?? '{}')).toEqual({ amount: 10, description: 'Refund' });
  });
});

describe('gateway accounts', () => {
  it('lists every gateway with its auth kind (GET /gateways)', async () => {
    const f = fixture([]);
    f.connect('STRIPE');
    const rows = await f.gateways.status();
    expect(rows.map((r) => [r.provider, r.auth, r.connected])).toEqual([
      ['NETPAY', 'keys', false],
      ['STRIPE', 'oauth', true],
      ['MERCADOPAGO', 'oauth', false],
      ['CONEKTA', 'keys', false],
      ['OPENPAY', 'keys', false],
    ]);
    expect(rows[1]).toMatchObject({ accountId: 'acct_123', supportsAutopay: true, environment: 'SANDBOX' });
  });

  it('connect refuses a return URL off the allowlist (422) and signs a state otherwise', async () => {
    const f = fixture([]);
    await expect(f.gateways.connect('STRIPE', 'https://evil.example/x')).rejects.toMatchObject({
      code: 'RETURN_URL_NOT_ALLOWED',
      status: 422,
    });
    const { authorizeUrl } = await f.gateways.connect('STRIPE', 'https://vondi.tupla.dev/admin?tab=pagos');
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://connect.stripe.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ca_123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/v1/payments/gateways/oauth/stripe/callback',
    );
    expect(url.searchParams.get('state')).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it('the OAuth callback stores the account and appends the outcome to the return URL query', async () => {
    const f = fixture([]);
    const state = new URL(
      (await f.gateways.connect('STRIPE', 'https://vondi.tupla.dev/admin?tab=pagos')).authorizeUrl,
    ).searchParams.get('state');
    f.answer([200, { stripe_user_id: 'acct_999', livemode: false }]);
    const redirect = await f.gateways.completeOAuth('STRIPE', { code: 'ac_1', state: state ?? '' });
    expect(redirect).toBe('https://vondi.tupla.dev/admin?tab=pagos&gateway=stripe&status=connected');
    expect(f.accounts.get('STRIPE')).toMatchObject({ externalAccountId: 'acct_999', environment: 'SANDBOX' });
    expect(f.routes).toContainEqual(
      expect.objectContaining({ provider: 'STRIPE', externalAccountId: 'acct_999' }),
    );
    await expect(f.gateways.completeOAuth('STRIPE', { code: 'ac_1', state: 'forged.state' })).rejects.toThrow(
      /state/,
    );
  });

  it('Conekta keys: validated, encrypted, routed by a hashed token, webhook registered', async () => {
    const f = fixture([], {
      routes: (call) =>
        call.url.endsWith('/orders?limit=1')
          ? [200, { data: [{ livemode: false }] }]
          : [200, { id: 'webhook_1' }],
    });
    const row = await f.gateways.saveCredentials('CONEKTA', {
      privateKey: 'key_private',
      publicKey: 'key_public',
    });

    expect(f.sent[0]?.url).toBe('https://api.conekta.io/orders?limit=1');
    const stored = f.accounts.get('CONEKTA');
    expect(stored?.['accessTokenCiphertext']).not.toContain('key_private');
    expect(
      f.box.decrypt(
        String(stored?.['accessTokenCiphertext']),
        PaymentSecretBox.aadForGateway(TENANT_ID, 'CONEKTA', 'access'),
      ),
    ).toBe('key_private');
    expect(stored?.['webhookId']).toBe('webhook_1');
    const hookUrl = String((JSON.parse(f.sent[1]?.body ?? '{}') as { url?: string }).url);
    const token = hookUrl.split('/payments/gateway-webhook/conekta/')[1] ?? '';
    expect(token.length).toBeGreaterThan(20);
    expect(f.routes).toContainEqual(
      expect.objectContaining({ provider: 'CONEKTA', externalAccountId: PaymentSecretBox.hashToken(token) }),
    );
    expect(row).toMatchObject({ provider: 'CONEKTA', auth: 'keys', connected: true, supportsAutopay: false });
  });

  it('refuses keys the gateway rejects, or that are malformed, with 422 GATEWAY_CREDENTIALS_INVALID', async () => {
    const f = fixture([]);
    f.answer([401, { message: 'unauthorized' }]);
    await expect(
      f.gateways.saveCredentials('CONEKTA', { privateKey: 'key_wrong', publicKey: 'key_public' }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CREDENTIALS_INVALID', status: 422 });
    await expect(
      f.gateways.saveCredentials('OPENPAY', { privateKey: 'not-a-key', publicKey: 'pk_x', merchantId: 'm1' }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CREDENTIALS_INVALID', status: 422 });
    expect(f.accounts.size).toBe(0);
  });

  it('Openpay keys are checked against the merchant on the chosen environment host', async () => {
    const f = fixture([], { routes: () => [200, { id: 'x' }] });
    await f.gateways.saveCredentials('OPENPAY', {
      privateKey: 'sk_private',
      publicKey: 'pk_public',
      merchantId: 'mabcdefghij1234567890',
      environment: 'LIVE',
    });
    expect(f.sent[0]?.url).toBe('https://api.openpay.mx/v1/mabcdefghij1234567890');
    expect(f.accounts.get('OPENPAY')).toMatchObject({
      environment: 'LIVE',
      externalAccountId: 'mabcdefghij1234567890',
    });
  });
});

describe('Stripe platform-account mode (staging only)', () => {
  const RETURN = 'https://vondi.tupla.dev/admin?tab=pagos';
  const account = [200, { id: 'acct_platform' }] as [number, unknown];

  it('connect creates the rows from GET /v1/account and returns the return URL as connected', async () => {
    const f = fixture([], { platformMode: true });
    f.answer(account);
    const { authorizeUrl } = await f.gateways.connect('STRIPE', RETURN);

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ url: 'https://api.stripe.com/v1/account', method: 'GET' });
    expect(authorizeUrl).toBe(`${RETURN}&gateway=stripe&status=connected`);
    expect(f.accounts.get('STRIPE')).toMatchObject({
      externalAccountId: 'acct_platform',
      environment: 'SANDBOX',
      accessTokenCiphertext: null,
    });
    expect(f.routes).toContainEqual(
      expect.objectContaining({
        provider: 'STRIPE',
        externalAccountId: 'acct_platform',
        tenantId: TENANT_ID,
      }),
    );
  });

  it('is idempotent for the same tenant and caches the account id', async () => {
    const f = fixture([], {
      platformMode: true,
      existingRoute: { tenantId: TENANT_ID, revokedAt: null },
    });
    f.answer(account);
    await f.gateways.connect('STRIPE', RETURN);
    await f.gateways.connect('STRIPE', RETURN);
    expect(f.sent).toHaveLength(1);
    expect(f.accounts.size).toBe(1);
  });

  it('answers 409 GATEWAY_ACCOUNT_IN_USE when another tenant holds the account', async () => {
    const f = fixture([], {
      platformMode: true,
      existingRoute: { tenantId: '22222222-2222-4222-8222-222222222222', revokedAt: null },
    });
    f.answer(account);
    await expect(f.gateways.connect('STRIPE', RETURN)).rejects.toMatchObject({
      code: 'GATEWAY_ACCOUNT_IN_USE',
      status: 409,
    });
    expect(f.accounts.size).toBe(0);
  });

  it('still refuses a return URL off the allowlist', async () => {
    const f = fixture([], { platformMode: true });
    await expect(f.gateways.connect('STRIPE', 'https://evil.example/x')).rejects.toMatchObject({
      code: 'RETURN_URL_NOT_ALLOWED',
    });
    expect(f.sent).toHaveLength(0);
  });

  it('disconnect revokes this tenant only and never calls oauth/deauthorize', async () => {
    const platform = fixture([], { platformMode: true });
    platform.connect('STRIPE', { externalAccountId: 'acct_platform' });
    await platform.gateways.disconnect('STRIPE');
    expect(platform.sent).toHaveLength(0);
    expect(platform.revoked[0]?.where).toMatchObject({ provider: 'STRIPE', tenantId: TENANT_ID });
    expect(platform.accounts.get('STRIPE')?.['disconnectedAt']).toBeInstanceOf(Date);
  });

  it('Connect mode still deauthorizes on disconnect', async () => {
    const f = fixture([]);
    f.connect('STRIPE');
    f.answer([200, {}]);
    await f.gateways.disconnect('STRIPE');
    expect(f.sent[0]?.url).toBe('https://connect.stripe.com/oauth/deauthorize');
  });

  it('sends no Stripe-Account header on create, verify, refund and charge-stored', async () => {
    const f = fixture([orderRow()], { platformMode: true });
    f.connect('STRIPE', { externalAccountId: 'acct_platform' });
    f.answer(
      [200, { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' }],
      [
        200,
        {
          id: 'cs_1',
          payment_intent: {
            id: 'pi_1',
            status: 'succeeded',
            amount: 10050,
            metadata: { bn_order_reference: REF },
          },
        },
      ],
      [200, { id: 're_1' }],
    );
    await f.service.create({ merchantReferenceCode: 'P', amount: '100.50', provider: 'STRIPE' });
    f.rows[0] = orderRow();
    await f.service.verifyGatewayOrder('order-1', null);
    await f.service.refund('order-1', 'Refund', '10.00');

    const g = fixture([orderRow({ checkoutMode: 'custom', checkoutSessionId: null })], {
      platformMode: true,
    });
    g.connect('STRIPE', { externalAccountId: 'acct_platform' });
    g.answer([
      200,
      { id: 'pi_9', status: 'succeeded', amount: 10050, metadata: { bn_order_reference: REF } },
    ]);
    await g.service.chargeStoredGateway('order-1', { clientId: 'cus_1', cardToken: 'pm_1abcdef' });

    const all = [...f.sent, ...g.sent];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const call of all) {
      expect(call.headers['Stripe-Account']).toBeUndefined();
      expect(call.headers['Authorization']).toBe('Bearer sk_test_platform');
    }
  });

  it('a refused live key leaves Stripe unavailable and warns once at startup', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fixture([], { refusedLiveKey: true });
    const stripe = (await f.gateways.status()).find((r) => r.provider === 'STRIPE');
    expect(stripe).toMatchObject({ available: false, connected: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('sk_test_');
    await expect(f.gateways.connect('STRIPE', RETURN)).rejects.toThrow(/not available/);
    expect(f.sent).toHaveLength(0);
  });
});
