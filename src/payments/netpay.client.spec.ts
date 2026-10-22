import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { NetpayClient, NetpayRequestError, NetpayTransportError, type HttpTransport } from './netpay.client';
import { netpayReportsUrl, netpayUrl } from './netpay-endpoints';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Builds a client over a transport that records every request and answers from a
 * queue, so each assertion is about what would have gone over the wire.
 *
 * @param answers Responses to give, in order.
 * @returns The client and the recorded requests.
 */
function clientAnswering(...answers: { status?: number; body?: unknown }[]) {
  const sent: Sent[] = [];
  const queue = [...answers];
  const transport: HttpTransport = {
    request: (url, init) => {
      sent.push({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      const next = queue.shift() ?? { status: 200, body: {} };
      return Promise.resolve({ status: next.status ?? 200, body: JSON.stringify(next.body ?? {}) });
    },
  };
  return { client: new NetpayClient(transport), sent };
}

const SK = 'sk_netpay_unit';

describe('Netpay URLs', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses the published sandbox and live gateways', () => {
    expect(netpayUrl('SANDBOX', '/v3/token/amount')).toBe(
      'https://gateway-154.netpaydev.com/gateway-ecommerce/v3/token/amount',
    );
    expect(netpayUrl('LIVE', '/v3/token/amount')).toBe(
      'https://suite.netpay.com.mx/gateway-ecommerce/v3/token/amount',
    );
  });

  it('puts refunds on the reports service', () => {
    expect(netpayReportsUrl('SANDBOX', '/v2/transactions/abc/refund')).toBe(
      'https://gateway.netpay-api.com/reports-sandbox/v2/transactions/abc/refund',
    );
    expect(netpayReportsUrl('LIVE', '/v2/transactions/abc/refund')).toBe(
      'https://out.netpay-api.com/reports/v2/transactions/abc/refund',
    );
  });

  it('ignores the sandbox override outside the test environment', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['NETPAY_SANDBOX_BASE_URL'] = 'http://127.0.0.1:1/x';
    process.env['NETPAY_SANDBOX_REPORTS_BASE_URL'] = 'http://127.0.0.1:1/y';
    expect(netpayUrl('SANDBOX', '/v3/webhooks/')).toContain('gateway-154.netpaydev.com');
    expect(netpayReportsUrl('SANDBOX', '/v2/a')).toContain('gateway.netpay-api.com');
  });

  it('never applies the override to the live account, even under test', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['NETPAY_SANDBOX_BASE_URL'] = 'http://127.0.0.1:1/x';
    process.env['NETPAY_SANDBOX_REPORTS_BASE_URL'] = 'http://127.0.0.1:1/y';
    expect(netpayUrl('LIVE', '/v3/webhooks/')).toContain('suite.netpay.com.mx');
    expect(netpayReportsUrl('LIVE', '/v2/a')).toContain('out.netpay-api.com');
    expect(netpayUrl('SANDBOX', '/v3/webhooks/')).toBe('http://127.0.0.1:1/x/v3/webhooks/');
  });

  it('refuses a path that could redirect the credential', () => {
    expect(() => netpayUrl('SANDBOX', '/v3/../evil')).toThrow();
    expect(() => netpayUrl('SANDBOX', '//evil.example')).toThrow();
    expect(() => netpayReportsUrl('SANDBOX', '/v2/../evil')).toThrow();
  });
});

describe('NetpayClient — Checkout Hosted', () => {
  it('creates a session on /v3.2/checkout/session/ with the secret key as Authorization', async () => {
    const { client, sent } = clientAnswering({
      body: {
        id: 1,
        sessionId: 'sess_1',
        hostedCheckoutUrl: 'https://gateway-154.netpaydev.com/hosted-checkout/session/sess_1/pk',
      },
    });
    const session = await client.createCheckoutSession('SANDBOX', SK, {
      paymentMethodTypes: ['card'],
      lineItems: [{ name: 'Order', amount: '650.00', quantity: '1', currency: 'MXN' }],
      linkType: 'NETPAY_CHECKOUT',
      merchantRefCode: 'ref-1',
      successUrl: 'https://shop.example/ok',
    });
    expect(session.hostedCheckoutUrl).toContain('hosted-checkout');
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3.2/checkout/session/');
    expect(sent[0].method).toBe('POST');
    expect(sent[0].headers['Authorization']).toBe(SK);
    expect(sent[0].body).toMatchObject({
      paymentMethodTypes: ['card'],
      linkType: 'NETPAY_CHECKOUT',
      merchantRefCode: 'ref-1',
    });
  });

  it('refuses a session answer that has no checkout URL', async () => {
    const { client } = clientAnswering({ body: { sessionId: 'sess_1' } });
    await expect(
      client.createCheckoutSession('SANDBOX', SK, {
        paymentMethodTypes: ['card'],
        lineItems: [],
        linkType: 'NETPAY_CHECKOUT',
        merchantRefCode: 'ref-1',
      }),
    ).rejects.toBeInstanceOf(NetpayTransportError);
  });
});

describe('NetpayClient — charges', () => {
  it('charges on /v3.5/charges/', async () => {
    const { client, sent } = clientAnswering({ body: { transactionTokenId: 't1', status: 'review' } });
    await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never);
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3.5/charges/');
    expect(sent[0].headers['User-Agent']).toBeDefined();
  });

  it('confirms a 3DS charge once, with the processor transaction id as a query parameter', async () => {
    const { client, sent } = clientAnswering({});
    await client.confirmCharge('SANDBOX', SK, 'tx 1', 'proc/9');
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe(
      'https://gateway-154.netpaydev.com/gateway-ecommerce/v3.5/charges/tx%201/confirm?processorTransactionId=proc%2F9',
    );
  });

  it('reads a transaction by its token id', async () => {
    const { client, sent } = clientAnswering({ body: { status: 'DONE', amount: 650 } });
    const tx = await client.getTransaction('SANDBOX', SK, 'abc');
    expect(tx.status).toBe('DONE');
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3/transactions/abc');
  });
});

describe('NetpayClient — refunds', () => {
  it('translates the token id, then reverses on the reports service with X-Netpay-Apikey', async () => {
    const { client, sent } = clientAnswering({ body: { transactionId: 'B1F6-REFUND-ID' } }, { body: {} });
    await client.refund('SANDBOX', SK, 'token-id-1', '650.00', 'Customer request');

    expect(sent).toHaveLength(2);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe(
      'https://gateway-154.netpaydev.com/gateway-ecommerce/v3/get/token-id-1/transactionId',
    );
    expect(sent[0].headers['Authorization']).toBe(SK);

    expect(sent[1].method).toBe('PUT');
    expect(sent[1].url).toBe(
      'https://gateway.netpay-api.com/reports-sandbox/v2/transactions/B1F6-REFUND-ID/refund',
    );
    expect(sent[1].headers['X-Netpay-Apikey']).toBe(SK);
    // The reports service reads its own header; the gateway one is not sent.
    expect(sent[1].headers['Authorization']).toBeUndefined();
    expect(sent[1].body).toEqual({ amount: '650.00', motive: 'Customer request' });
  });

  it('does not attempt the reversal when the id cannot be resolved', async () => {
    const { client, sent } = clientAnswering({ status: 404, body: { message: 'not found' } });
    await expect(client.refund('SANDBOX', SK, 'missing', '1.00', 'x')).rejects.toBeInstanceOf(
      NetpayRequestError,
    );
    expect(sent).toHaveLength(1);
  });

  it('refuses an answer that carries no refundable id', async () => {
    const { client, sent } = clientAnswering({ body: {} });
    await expect(client.refund('SANDBOX', SK, 'tx', '1.00', 'x')).rejects.toBeInstanceOf(
      NetpayTransportError,
    );
    expect(sent).toHaveLength(1);
  });

  it("carries Netpay's own message on a refusal, and nothing else from its body", async () => {
    const { client } = clientAnswering(
      { body: { transactionId: 'id' } },
      {
        status: 500,
        body: {
          code: 1011,
          message: 'No es posible mostrar transacciones por el momento.',
          echoed: 'sk_netpay_secret',
        },
      },
    );
    const error = await client.refund('SANDBOX', SK, 'tx', '1.00', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetpayRequestError);
    const refusal = error as NetpayRequestError;
    expect(refusal.providerStatus).toBe(500);
    expect(refusal.providerMessage).toBe('No es posible mostrar transacciones por el momento.');
    expect(JSON.stringify(refusal.details)).not.toContain('sk_netpay_secret');
  });

  it('surfaces a provider refusal as an upstream error', async () => {
    const { client } = clientAnswering(
      { body: { transactionId: 'id' } },
      { status: 400, body: { message: 'Comercio no tiene permitida esta operativa' } },
    );
    await expect(client.refund('SANDBOX', SK, 'tx', '1.00', 'x')).rejects.toBeInstanceOf(NetpayRequestError);
  });
});

describe('NetpayClient — other calls', () => {
  it('tokenises an amount on /v3/token/amount', async () => {
    const { client, sent } = clientAnswering({ body: { tokenAmount: 'tokenAmount_1', amount: 650 } });
    await client.tokenizeAmount('SANDBOX', SK, 650);
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3/token/amount');
    expect(sent[0].body).toEqual({ amount: 650 });
  });

  it('creates a customer on /v4/clients', async () => {
    const { client, sent } = clientAnswering({ body: { id: 'cus_1' } });
    await client.createClient('SANDBOX', SK, {
      firstName: 'A',
      lastName: 'B',
      phone: '1',
      email: 'a@b.mx',
      identifier: 'x',
    });
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v4/clients');
  });

  it('registers the webhook with PUT /v3/webhooks/', async () => {
    const { client, sent } = clientAnswering({});
    await client.registerWebhook('SANDBOX', SK, 'https://shop.example/hook');
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3/webhooks/');
    expect(sent[0].body).toEqual({ webhook: 'https://shop.example/hook' });
  });
});

describe('NetpayClient — documented behaviours added in the review', () => {
  it('forwards the buyer user agent, and replaces one that is not safe to send', async () => {
    const { client, sent } = clientAnswering({}, {});
    await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never, 'Mozilla/5.0 Buyer');
    await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never, 'bad\r\nX-Evil: 1');
    expect(sent[0].headers['User-Agent']).toBe('Mozilla/5.0 Buyer');
    expect(sent[1].headers['User-Agent']).toContain('Mozilla/5.0');
    expect(sent[1].headers['User-Agent']).not.toContain('Evil');
  });

  it('sends the security code on a stored-card charge', async () => {
    const { client, sent } = clientAnswering({});
    await client.createCharge('SANDBOX', SK, { source: 'token_x', cvv: '123', saveCard: 'false' } as never);
    expect(sent[0].body).toMatchObject({ cvv: '123', saveCard: 'false' });
  });

  it('confirms with a null processor id when no challenge was needed', async () => {
    const { client, sent } = clientAnswering({});
    await client.confirmCharge('SANDBOX', SK, 'tx1', null);
    expect(sent[0].url).toBe(
      'https://gateway-154.netpaydev.com/gateway-ecommerce/v3.5/charges/tx1/confirm?processorTransactionId=null',
    );
  });

  it('reads a customer on GET /v3/clients/{id}', async () => {
    const { client, sent } = clientAnswering({ body: { id: 'c1', paymentSources: [] } });
    await client.getClient('SANDBOX', SK, 'c 1');
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3/clients/c%201');
  });

  it('attaches a card with PUT /v3/clients/{id}/token and string flags', async () => {
    const { client, sent } = clientAnswering({ body: { token: 't', lastFourDigits: '1111' } });
    await client.assignCard('SANDBOX', SK, 'c1', 'token_abc', '123', true);
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].url).toBe('https://gateway-154.netpaydev.com/gateway-ecommerce/v3/clients/c1/token');
    expect(sent[0].body).toEqual({ token: 'token_abc', cvv2: '123', preAuth: 'true' });
  });

  it('deletes a card with DELETE /v3/clients/{id}/token/{card}', async () => {
    const { client, sent } = clientAnswering({ body: { responseMsg: 'Token eliminado correctamente' } });
    await client.deleteCard('SANDBOX', SK, 'c1', 'token_abc');
    expect(sent[0].method).toBe('DELETE');
    expect(sent[0].url).toBe(
      'https://gateway-154.netpaydev.com/gateway-ecommerce/v3/clients/c1/token/token_abc',
    );
    expect(sent[0].body).toBeUndefined();
  });

  it('reads the registered webhook with GET /v3/webhooks/', async () => {
    const { client, sent } = clientAnswering({ body: { webhook: 'https://shop.example/hook' } });
    const answer = await client.getWebhook('SANDBOX', SK);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe('https://gateway-154.netpay' + 'dev.com/gateway-ecommerce/v3/webhooks/');
    expect(answer['webhook']).toBe('https://shop.example/hook');
  });
});

describe('NetpayClient — declines', () => {
  it('returns a declined charge (4xx carrying a transaction) instead of raising', async () => {
    const { client } = clientAnswering({
      status: 409,
      body: {
        transactionTokenId: 'tx-declined',
        status: 'failed',
        error: 'Rejected by Decision Manager',
        cvv: '123',
      },
    });
    const tx = await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never);
    expect(tx.transactionTokenId).toBe('tx-declined');
    expect(tx.status).toBe('failed');
    expect(tx.declineReason).toBe('Rejected by Decision Manager');
  });

  it('still raises on a 4xx that carries no transaction', async () => {
    const { client } = clientAnswering({ status: 400, body: { message: 'Invalid Token' } });
    const error = await client
      .createCharge('SANDBOX', SK, { source: 'token_x' } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetpayRequestError);
    expect((error as NetpayRequestError).providerMessage).toBe('Invalid Token');
  });

  it.each([
    [400, 'failed'],
    [404, 'failed'],
    [409, 'success'],
    [409, 'review'],
  ])(
    'raises on %i with a transaction whose status is %s: only a 409 decline is an outcome',
    async (status, txStatus) => {
      const { client } = clientAnswering({ status, body: { transactionTokenId: 'tx', status: txStatus } });
      await expect(client.createCharge('SANDBOX', SK, { source: 'token_x' } as never)).rejects.toBeInstanceOf(
        NetpayRequestError,
      );
    },
  );

  it('still raises on a 5xx, even with a transaction in the body', async () => {
    const { client } = clientAnswering({ status: 500, body: { transactionTokenId: 'tx' } });
    await expect(client.createCharge('SANDBOX', SK, { source: 'token_x' } as never)).rejects.toBeInstanceOf(
      NetpayRequestError,
    );
  });
});

describe('NetpayClient — provider-echoed values never leave the client (BN-TASK-023)', () => {
  const PAN = '4111111111111111';
  const CVV = '987';
  const EMAIL = 'ana.lopez@example.mx';
  /** A 400 that echoes what was sent, the way Netpay's validation errors do. */
  const echoed = {
    message: 'Argument not valid',
    subErrors: [
      { object: 'charge', field: 'source', rejectedValue: PAN, value: PAN, message: 'Invalid card' },
      { object: 'charge', field: 'cvv', value: CVV, message: `cvv ${CVV} is invalid` },
      { object: 'billing', field: 'email', value: EMAIL },
    ],
  };

  it('keeps field names only: no PAN, CVV or e-mail in the error, its details or the log', async () => {
    const { client } = clientAnswering({ status: 400, body: echoed });
    const logged: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => void logged.push(String(message)));
    const error = await client
      .createCharge('SANDBOX', SK, { source: 'token_x' } as never)
      .catch((e: unknown) => e);
    spy.mockRestore();
    expect(error).toBeInstanceOf(NetpayRequestError);
    const refusal = error as NetpayRequestError;
    const everything = JSON.stringify({
      message: refusal.message,
      providerMessage: refusal.providerMessage,
      details: refusal.details,
      logged,
    });
    expect(everything).not.toContain(PAN);
    expect(everything).not.toContain('1111');
    expect(everything).not.toContain(CVV);
    expect(everything).not.toContain(EMAIL);
    expect(refusal.providerMessage).toBe('Argument not valid (source; cvv; email)');
  });

  it('drops digit runs that look like a card number from the provider message itself', async () => {
    const { client } = clientAnswering({ status: 400, body: { message: `Card ${PAN} rejected` } });
    const error = (await client
      .getTransaction('SANDBOX', SK, 'tx')
      .catch((e: unknown) => e)) as NetpayRequestError;
    expect(error.providerMessage).not.toContain(PAN);
  });

  it('keeps a declined charge free of the echoed values too', async () => {
    const { client } = clientAnswering({
      status: 409,
      body: { transactionTokenId: 'tx-d', status: 'failed', error: 'Rejected', subErrors: echoed.subErrors },
    });
    const tx = await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never);
    expect(JSON.stringify(tx)).not.toContain(PAN);
    expect(JSON.stringify(tx)).not.toContain(EMAIL);
  });
});

describe('NetpayClient — decline codes (BN-TASK-020)', () => {
  it('maps a decline to the stable enum and keeps the original code internally', async () => {
    const { client } = clientAnswering({
      status: 409,
      body: {
        transactionTokenId: 'tx-d',
        status: 'failed',
        responseCode: '51',
        error: 'Fondos insuficientes',
      },
    });
    const tx = await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never);
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.providerFailureCode).toBe('51');
  });

  it('classifies the Decision Manager rejection as suspected fraud', async () => {
    const { client } = clientAnswering({
      status: 409,
      body: { transactionTokenId: 'tx-d', status: 'failed', error: 'Rejected by Decision Manager' },
    });
    const tx = await client.createCharge('SANDBOX', SK, { source: 'token_x' } as never);
    expect(tx.failureCode).toBe('FRAUD_SUSPECTED');
  });
});

describe('NetpayClient — credential check (BN-TASK-025)', () => {
  it('reads the webhook registration, which changes nothing, to prove the key', async () => {
    const { client, sent } = clientAnswering({ status: 200, body: { webhook: null } });
    await expect(client.checkCredentials('SANDBOX', SK)).resolves.toBe('VALID');
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe('https://gateway-154.netpay' + 'dev.com/gateway-ecommerce/v3/webhooks/');
    expect(sent[0].headers['Authorization']).toBe(SK);
  });

  it.each([401, 403])('reports a key the environment refuses (%i) as invalid', async (status) => {
    const { client } = clientAnswering({ status, body: { message: 'Please Verify your ApiKeys' } });
    await expect(client.checkCredentials('LIVE', SK)).resolves.toBe('INVALID');
  });

  it('treats a 404 (nothing registered yet) as an accepted key', async () => {
    const { client } = clientAnswering({ status: 404, body: { message: 'No message available' } });
    await expect(client.checkCredentials('SANDBOX', SK)).resolves.toBe('VALID');
  });

  it('does not guess on a 5xx: the caller sees an unknown outcome', async () => {
    const { client } = clientAnswering({ status: 500, body: {} });
    await expect(client.checkCredentials('SANDBOX', SK)).rejects.toMatchObject({
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
  });
});

describe('NetpayClient latency log (BN-TASK-044, BN-REQ-OPS-005)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs netpay_request with a bounded operation name, the outcome and the latency', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client } = clientAnswering({ status: 200, body: { transactionTokenId: 'tx', status: 'DONE' } });
    await client.getTransaction('SANDBOX', SK, 'c4f1a9e2-0000-4000-8000-000000000001');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'netpay_request',
        // The id is not part of the label: one series per endpoint, not per transaction.
        operation: 'GET /v3/transactions/:id',
        outcome: 'ok',
        httpStatus: 200,
        latencyMs: expect.any(Number) as unknown,
      }),
    );
  });

  it('logs a provider error at warn with its status', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { client } = clientAnswering({ status: 502, body: { message: 'down' } });
    await expect(client.getTransaction('SANDBOX', SK, 'tx-1')).rejects.toBeInstanceOf(NetpayRequestError);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'netpay_request', outcome: 'error', httpStatus: 502 }),
    );
  });

  it('logs a timeout as such, and never the secret key', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = new NetpayClient({ request: () => Promise.reject(new Error('Request timed out.')) });
    await expect(client.confirmCharge('SANDBOX', SK, 'tx-9', 'proc-1')).rejects.toBeInstanceOf(
      NetpayTransportError,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'netpay_request',
        operation: 'POST /v3.5/charges/:id/confirm',
        outcome: 'timeout',
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SK);
  });
});
