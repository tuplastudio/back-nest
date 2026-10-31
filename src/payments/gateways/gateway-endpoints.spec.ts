import { createHmac } from 'node:crypto';
import {
  OAUTH_STATE_TTL_MS,
  conektaOrderToTransaction,
  fromCents,
  isAllowedReturnUrl,
  mercadoPagoPaymentToTransaction,
  openpayChargeToTransaction,
  parseGatewayParam,
  signOAuthState,
  stripeIntentToTransaction,
  stripeSavedCard,
  toCents,
  toStripeForm,
  verifyMercadoPagoSignature,
  verifyOAuthState,
  verifyStripeSignature,
  withQuery,
} from './gateway-endpoints';

/** The security-relevant pure pieces of the gateway integration (docs 33), byte for byte. */

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const sign = (t: number, payload = body, key = secret): string =>
    `t=${t},v1=${createHmac('sha256', key).update(`${t}.${payload}`).digest('hex')}`;

  it('accepts a fresh, correctly signed body (any of several v1)', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyStripeSignature(Buffer.from(body), sign(t), secret, NOW)).toBe(true);
    expect(verifyStripeSignature(body, `t=${t},v1=deadbeef,${sign(t).split(',')[1]}`, secret, NOW)).toBe(
      true,
    );
  });

  it('refuses a wrong secret, a tampered body, a missing header or a malformed one', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyStripeSignature(body, sign(t, body, 'whsec_other'), secret, NOW)).toBe(false);
    expect(verifyStripeSignature(`${body} `, sign(t), secret, NOW)).toBe(false);
    expect(verifyStripeSignature(body, undefined, secret, NOW)).toBe(false);
    expect(verifyStripeSignature(body, 'v1=abc', secret, NOW)).toBe(false);
  });

  it('refuses a stale timestamp (replay) beyond the 5 minute tolerance', () => {
    const stale = Math.floor(NOW / 1000) - 301;
    expect(verifyStripeSignature(body, sign(stale), secret, NOW)).toBe(false);
    expect(verifyStripeSignature(body, sign(stale + 2), secret, NOW)).toBe(true);
  });
});

describe('verifyMercadoPagoSignature', () => {
  const secret = 'mp-webhook-secret-123';
  const v1 = (manifest: string): string => createHmac('sha256', secret).update(manifest).digest('hex');

  it('accepts the documented manifest id:<data.id>;request-id:<x-request-id>;ts:<ts>;', () => {
    const signature = `ts=1704908010,v1=${v1('id:123456;request-id:req-1;ts:1704908010;')}`;
    expect(verifyMercadoPagoSignature({ signature, requestId: 'req-1', dataId: '123456', secret })).toBe(
      true,
    );
  });

  it('lower-cases an alphanumeric id and drops parts that are absent', () => {
    const signature = `ts=17,v1=${v1('id:abc1;ts:17;')}`;
    expect(verifyMercadoPagoSignature({ signature, requestId: undefined, dataId: 'ABC1', secret })).toBe(
      true,
    );
  });

  it('refuses another id, another secret or a missing header', () => {
    const signature = `ts=1,v1=${v1('id:1;request-id:r;ts:1;')}`;
    expect(verifyMercadoPagoSignature({ signature, requestId: 'r', dataId: '2', secret })).toBe(false);
    expect(
      verifyMercadoPagoSignature({ signature, requestId: 'r', dataId: '1', secret: 'x'.repeat(20) }),
    ).toBe(false);
    expect(verifyMercadoPagoSignature({ signature: undefined, requestId: 'r', dataId: '1', secret })).toBe(
      false,
    );
  });
});

describe('OAuth state', () => {
  const key = Buffer.alloc(32, 7);
  const input = {
    tenantId: 'tenant-1',
    provider: 'STRIPE' as const,
    returnUrl: 'https://vondi.tupla.dev/admin?tab=pagos',
  };

  it('round-trips tenant, provider and return URL', () => {
    const state = verifyOAuthState(key, signOAuthState(key, input, NOW), NOW + 1000);
    expect(state).toMatchObject({ t: 'tenant-1', p: 'STRIPE', r: input.returnUrl });
  });

  it('refuses a tampered payload, another key, or an expired state', () => {
    const token = signOAuthState(key, input, NOW);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), t: 'tenant-2' }),
    ).toString('base64url');
    expect(verifyOAuthState(key, `${forged}.${mac}`, NOW)).toBeNull();
    expect(verifyOAuthState(Buffer.alloc(32, 8), token, NOW)).toBeNull();
    expect(verifyOAuthState(key, token, NOW + OAUTH_STATE_TTL_MS + 1)).toBeNull();
    expect(verifyOAuthState(key, undefined, NOW)).toBeNull();
  });

  it('checks the return URL against the allowlist by origin', () => {
    const origins = ['https://vondi.tupla.dev'];
    expect(isAllowedReturnUrl('https://vondi.tupla.dev/admin?tab=pagos', origins)).toBe(true);
    expect(isAllowedReturnUrl('https://vondi.tupla.dev.evil.com/x', origins)).toBe(false);
    expect(isAllowedReturnUrl('javascript:alert(1)', origins)).toBe(false);
    expect(isAllowedReturnUrl('https://vondi.tupla.dev/', [])).toBe(false);
  });

  it('appends the outcome to the return URL query instead of replacing it', () => {
    expect(
      withQuery('https://vondi.tupla.dev/admin?tab=pagos', { gateway: 'stripe', status: 'connected' }),
    ).toBe('https://vondi.tupla.dev/admin?tab=pagos&gateway=stripe&status=connected');
  });
});

describe('amounts, form encoding and provider names', () => {
  it('converts between two-decimal amounts and cents exactly', () => {
    expect(toCents('100.50')).toBe(10050);
    expect(toCents('19.99')).toBe(1999);
    expect(toCents('7')).toBe(700);
    expect(fromCents(1999)).toBe('19.99');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(1.5)).toBeNull();
  });

  it('encodes nested objects the way Stripe expects and skips undefined', () => {
    const form = toStripeForm({ a: [{ b: { c: 'x' } }], d: undefined, e: true });
    expect(decodeURIComponent(form)).toBe('a[0][b][c]=x&e=true');
  });

  it('reads the four gateways from a path segment', () => {
    expect(parseGatewayParam('stripe')).toBe('STRIPE');
    expect(parseGatewayParam('MercadoPago')).toBe('MERCADOPAGO');
    expect(parseGatewayParam('conekta')).toBe('CONEKTA');
    expect(parseGatewayParam('openpay')).toBe('OPENPAY');
    expect(parseGatewayParam('netpay')).toBeNull();
  });
});

describe('mapping a gateway payment onto the verification shape', () => {
  it('Stripe: succeeded ⇒ DONE with the metadata reference and the amount from cents', () => {
    expect(
      stripeIntentToTransaction({
        id: 'pi_1',
        status: 'succeeded',
        amount: 10050,
        currency: 'mxn',
        metadata: { bn_order_reference: 'VND_1' },
      }),
    ).toMatchObject({ status: 'DONE', merchantReferenceCode: 'VND_1', amount: '100.50', currency: 'MXN' });
  });

  it('Stripe: a failed attempt or a cancellation ⇒ FAILED; processing ⇒ REVIEW', () => {
    expect(
      stripeIntentToTransaction({
        id: 'pi_1',
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined' },
      }).status,
    ).toBe('FAILED');
    expect(stripeIntentToTransaction({ id: 'pi_1', status: 'canceled' }).status).toBe('FAILED');
    expect(stripeIntentToTransaction({ id: 'pi_1', status: 'requires_payment_method' }).status).toBe(
      'REVIEW',
    );
    expect(stripeIntentToTransaction({ id: 'pi_1', status: 'processing' }).status).toBe('REVIEW');
  });

  it('Stripe: a saved card only for a succeeded off_session intent', () => {
    const intent = {
      id: 'pi_1',
      status: 'succeeded',
      setup_future_usage: 'off_session',
      customer: 'cus_1',
      payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242' } },
    };
    expect(stripeSavedCard(intent)).toEqual({
      clientId: 'cus_1',
      cardToken: 'pm_1',
      brand: 'visa',
      last4: '4242',
    });
    expect(stripeSavedCard({ ...intent, setup_future_usage: null })).toBeNull();
  });

  it('Mercado Pago, Conekta and Openpay statuses', () => {
    expect(
      mercadoPagoPaymentToTransaction({
        id: 1,
        status: 'approved',
        transaction_amount: 100,
        external_reference: 'R',
      }),
    ).toMatchObject({
      status: 'DONE',
      amount: '100.00',
      merchantReferenceCode: 'R',
      transactionTokenId: '1',
    });
    expect(mercadoPagoPaymentToTransaction({ id: 1, status: 'rejected' }).status).toBe('FAILED');
    expect(mercadoPagoPaymentToTransaction({ id: 1, status: 'in_process' }).status).toBe('REVIEW');
    expect(
      conektaOrderToTransaction({
        id: 'ord_1',
        payment_status: 'paid',
        amount: 10050,
        metadata: { bn_order_reference: 'R' },
      }),
    ).toMatchObject({ status: 'DONE', amount: '100.50', merchantReferenceCode: 'R' });
    expect(conektaOrderToTransaction({ id: 'ord_1', payment_status: 'expired' }).status).toBe('FAILED');
    expect(conektaOrderToTransaction({ id: 'ord_1', payment_status: 'pending_payment' }).status).toBe(
      'REVIEW',
    );
    expect(
      openpayChargeToTransaction({ id: 'tr1', status: 'completed', amount: 100.5, order_id: 'R' }),
    ).toMatchObject({
      status: 'DONE',
      amount: '100.50',
      merchantReferenceCode: 'R',
    });
    expect(openpayChargeToTransaction({ id: 'tr1', status: 'cancelled' }).status).toBe('FAILED');
    expect(openpayChargeToTransaction({ id: 'tr1', status: 'in_progress' }).status).toBe('REVIEW');
  });
});
