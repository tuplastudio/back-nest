import { describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { GatewayWebhookService } from './gateway-webhook.service';
import { PaymentSecretBox } from '../payment-secret-box';

const WHSEC = 'whsec_test';
const MP_SECRET = 'mp_secret';
const SCOPE = { tenantId: 't1', schemaName: 'tenant_t1' };

function setup(opts: { scope?: typeof SCOPE | null; orderId?: string | null; platformMode?: boolean } = {}) {
  const gateways = {
    platform: { stripe: { webhookSecret: WHSEC }, mercadoPago: { webhookSecret: MP_SECRET } },
    resolveRoute: jest.fn((..._args: unknown[]) =>
      Promise.resolve(opts.scope === undefined ? SCOPE : opts.scope),
    ),
    stripePlatformMode: () => opts.platformMode === true,
    platformAccountId: jest.fn(() => Promise.resolve('acct_platform')),
    markDeauthorized: jest.fn((..._args: unknown[]) => Promise.resolve()),
    lookup: jest.fn((..._args: unknown[]) =>
      Promise.resolve({ transaction: { merchantReferenceCode: 'REF-1' } }),
    ),
  };
  const orders = {
    findGatewayOrderIdInSchema: jest.fn((..._args: unknown[]) =>
      Promise.resolve(opts.orderId === undefined ? 'o1' : opts.orderId),
    ),
    verifyGatewayOrderInSchema: jest.fn((..._args: unknown[]) => Promise.resolve({ status: 'PAID' })),
  };
  const service = new GatewayWebhookService(gateways as never, orders as never);
  return { service, gateways, orders };
}

function stripeBody(event: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(event));
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', WHSEC)
    .update(`${t}.${raw.toString('utf8')}`)
    .digest('hex')}`;
  return { raw, sig };
}

function mpHeaders(dataId: string, requestId = 'req-1') {
  const ts = '1700000000';
  const v1 = createHmac('sha256', MP_SECRET)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  return { signature: `ts=${ts},v1=${v1}`, requestId };
}

describe('GatewayWebhookService.receiveStripe', () => {
  const paid = {
    type: 'payment_intent.succeeded',
    account: 'acct_1',
    data: { object: { id: 'pi_1', object: 'payment_intent', metadata: { bn_order_reference: 'REF-1' } } },
  };

  it('verifies a signed event through the order lookup and the gateway', async () => {
    const { service, orders } = setup();
    const { raw, sig } = stripeBody(paid);
    await service.receiveStripe(raw, sig);
    expect(orders.findGatewayOrderIdInSchema).toHaveBeenCalledWith('tenant_t1', 'STRIPE', {
      orderReference: 'REF-1',
      netpayTransactionId: 'pi_1',
    });
    expect(orders.verifyGatewayOrderInSchema).toHaveBeenCalledWith(
      'tenant_t1',
      'o1',
      't1',
      'pi_1',
      'webhook',
    );
  });

  it('treats an event without `account` as the platform account only in platform mode', async () => {
    const { account: _drop, ...bare } = paid;
    for (const platformMode of [true, false]) {
      const { service, gateways, orders } = setup({ platformMode });
      const { raw, sig } = stripeBody(bare);
      await service.receiveStripe(raw, sig);
      if (platformMode) {
        expect(gateways.resolveRoute).toHaveBeenCalledWith('STRIPE', 'acct_platform');
        expect(orders.verifyGatewayOrderInSchema).toHaveBeenCalledTimes(1);
      } else {
        expect(gateways.resolveRoute).not.toHaveBeenCalled();
        expect(orders.verifyGatewayOrderInSchema).not.toHaveBeenCalled();
      }
    }
  });

  it('ignores a bad signature, a missing body and unparsable JSON without touching anything', async () => {
    const { service, gateways } = setup();
    const { raw } = stripeBody(paid);
    await service.receiveStripe(raw, 't=1,v1=bad');
    await service.receiveStripe(undefined, 't=1,v1=bad');
    const junk = Buffer.from('not json');
    const t = Math.floor(Date.now() / 1000);
    await service.receiveStripe(
      junk,
      `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.not json`).digest('hex')}`,
    );
    expect(gateways.resolveRoute).not.toHaveBeenCalled();
  });

  it('marks the account deauthorized and stops', async () => {
    const { service, gateways, orders } = setup();
    const { raw, sig } = stripeBody({ type: 'account.application.deauthorized', account: 'acct_1' });
    await service.receiveStripe(raw, sig);
    expect(gateways.markDeauthorized).toHaveBeenCalledWith(SCOPE, 'acct_1');
    expect(orders.verifyGatewayOrderInSchema).not.toHaveBeenCalled();
  });

  it('drops events with no account, an unrouted account, an unrelated type or an unknown order', async () => {
    const a = setup();
    const noAccount = stripeBody({ type: 'payment_intent.succeeded' });
    await a.service.receiveStripe(noAccount.raw, noAccount.sig);
    expect(a.gateways.resolveRoute).not.toHaveBeenCalled();

    const b = setup({ scope: null });
    const routed = stripeBody(paid);
    await b.service.receiveStripe(routed.raw, routed.sig);
    expect(b.orders.findGatewayOrderIdInSchema).not.toHaveBeenCalled();

    const c = setup();
    const other = stripeBody({ type: 'customer.created', account: 'acct_1' });
    await c.service.receiveStripe(other.raw, other.sig);
    expect(c.orders.findGatewayOrderIdInSchema).not.toHaveBeenCalled();

    const d = setup({ orderId: null });
    const unknown = stripeBody(paid);
    await d.service.receiveStripe(unknown.raw, unknown.sig);
    expect(d.orders.verifyGatewayOrderInSchema).not.toHaveBeenCalled();
  });

  it('finds a Checkout Session by its id and PaymentIntent', async () => {
    const { service, orders } = setup();
    const { raw, sig } = stripeBody({
      type: 'checkout.session.completed',
      account: 'acct_1',
      data: { object: { id: 'cs_1', object: 'checkout.session', payment_intent: 'pi_9' } },
    });
    await service.receiveStripe(raw, sig);
    expect(orders.findGatewayOrderIdInSchema).toHaveBeenCalledWith('tenant_t1', 'STRIPE', {
      checkoutSessionId: 'cs_1',
      netpayTransactionId: 'pi_9',
    });
  });

  it('never throws when verification fails: the caller always gets the same answer', async () => {
    const { service, orders } = setup();
    orders.verifyGatewayOrderInSchema.mockRejectedValueOnce(new Error('boom'));
    const { raw, sig } = stripeBody(paid);
    await expect(service.receiveStripe(raw, sig)).resolves.toBeUndefined();
  });
});

describe('GatewayWebhookService.receiveMercadoPago', () => {
  const body = { type: 'payment', user_id: 77, data: { id: '123' } };

  it('looks the payment up with the seller token and finds the order as MERCADOPAGO', async () => {
    const { service, gateways, orders } = setup();
    await service.receiveMercadoPago({ ...mpHeaders('123'), queryDataId: '123', body });
    expect(gateways.resolveRoute).toHaveBeenCalledWith('MERCADOPAGO', '77');
    expect(gateways.lookup).toHaveBeenCalled();
    // Regression: the order was once searched under STRIPE, so no MP payment ever matched.
    expect(orders.findGatewayOrderIdInSchema).toHaveBeenCalledWith('tenant_t1', 'MERCADOPAGO', {
      orderReference: 'REF-1',
    });
    expect(orders.verifyGatewayOrderInSchema).toHaveBeenCalledWith('tenant_t1', 'o1', 't1', '123', 'webhook');
  });

  it('rejects a bad signature, a non-payment type, a non-numeric id and a missing user', async () => {
    const { service, gateways } = setup();
    await service.receiveMercadoPago({ signature: 'ts=1,v1=bad', requestId: 'r', queryDataId: '123', body });
    await service.receiveMercadoPago({
      ...mpHeaders('123'),
      queryDataId: '123',
      body: { ...body, type: 'plan' },
    });
    await service.receiveMercadoPago({ ...mpHeaders('abc'), queryDataId: 'abc', body });
    await service.receiveMercadoPago({ ...mpHeaders('123'), queryDataId: '123', body: { type: 'payment' } });
    expect(gateways.resolveRoute).not.toHaveBeenCalled();
  });

  it('stops quietly when the account is unrouted, the lookup fails or names no order', async () => {
    const a = setup({ scope: null });
    await a.service.receiveMercadoPago({ ...mpHeaders('123'), queryDataId: '123', body });
    expect(a.gateways.lookup).not.toHaveBeenCalled();

    const b = setup();
    b.gateways.lookup.mockRejectedValueOnce(new Error('mp down'));
    await b.service.receiveMercadoPago({ ...mpHeaders('123'), queryDataId: '123', body });
    expect(b.orders.findGatewayOrderIdInSchema).not.toHaveBeenCalled();

    const c = setup();
    c.gateways.lookup.mockResolvedValueOnce({ transaction: {} } as never);
    await c.service.receiveMercadoPago({ ...mpHeaders('123'), queryDataId: '123', body });
    expect(c.orders.findGatewayOrderIdInSchema).not.toHaveBeenCalled();
  });
});

describe('GatewayWebhookService.receiveWithToken', () => {
  it('routes by the hash of the URL token, never the token itself', async () => {
    const { service, gateways } = setup({ scope: null });
    await service.receiveWithToken('CONEKTA', 'secret-token', {});
    expect(gateways.resolveRoute).toHaveBeenCalledWith('CONEKTA', PaymentSecretBox.hashToken('secret-token'));
  });

  it('Conekta: takes the order id from an order or a charge object', async () => {
    const a = setup();
    await a.service.receiveWithToken('CONEKTA', 'tok', {
      data: { object: { object: 'order', id: 'ord_1' } },
    });
    expect(a.orders.findGatewayOrderIdInSchema).toHaveBeenCalledWith('tenant_t1', 'CONEKTA', {
      checkoutSessionId: 'ord_1',
      netpayTransactionId: 'ord_1',
    });
    expect(a.orders.verifyGatewayOrderInSchema).toHaveBeenCalledWith(
      'tenant_t1',
      'o1',
      't1',
      'ord_1',
      'webhook',
    );

    const b = setup();
    await b.service.receiveWithToken('CONEKTA', 'tok', {
      data: { object: { object: 'charge', order_id: 'ord_2' } },
    });
    expect(b.orders.verifyGatewayOrderInSchema).toHaveBeenCalledWith(
      'tenant_t1',
      'o1',
      't1',
      'ord_2',
      'webhook',
    );
  });

  it('Openpay: logs the verification code and does nothing else', async () => {
    const { service, orders } = setup();
    await service.receiveWithToken('OPENPAY', 'tok', { type: 'verification', verification_code: '123456' });
    expect(orders.findGatewayOrderIdInSchema).not.toHaveBeenCalled();
  });

  it('Openpay: finds the order by transaction id and merchant order_id', async () => {
    const { service, orders } = setup();
    await service.receiveWithToken('OPENPAY', 'tok', {
      type: 'charge.succeeded',
      transaction: { id: 'tr_1', order_id: 'REF-1' },
    });
    expect(orders.findGatewayOrderIdInSchema).toHaveBeenCalledWith('tenant_t1', 'OPENPAY', {
      checkoutSessionId: 'tr_1',
      netpayTransactionId: 'tr_1',
      orderReference: 'REF-1',
    });
  });

  it('ignores a body with no usable id or an unknown order', async () => {
    const a = setup();
    await a.service.receiveWithToken('OPENPAY', 'tok', { transaction: {} });
    await a.service.receiveWithToken('CONEKTA', 'tok', null);
    expect(a.orders.findGatewayOrderIdInSchema).not.toHaveBeenCalled();

    const b = setup({ orderId: null });
    await b.service.receiveWithToken('CONEKTA', 'tok', {
      data: { object: { object: 'order', id: 'ord_1' } },
    });
    expect(b.orders.verifyGatewayOrderInSchema).not.toHaveBeenCalled();
  });
});
