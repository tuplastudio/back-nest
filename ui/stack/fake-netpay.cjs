/**
 * Stand-in for the Netpay gateway, with a control API for the test UI.
 *
 * Gateway routes live under `/gateway-ecommerce`. The control routes live under
 * `/__control` and let the page decide what Netpay "says": approve or decline a
 * transaction, change its amount, make the next call fail, or bind a different
 * amount to a token.
 */
const http = require('node:http');
const crypto = require('node:crypto');

function startFakeNetpay(port) {
  const state = {
    calls: [],
    transactions: new Map(),
    failNext: 0,
    tokenAmountOverride: null,
    /** When true, the next charge answers with a 3-D Secure challenge. */
    threeDS: false,
    sessions: new Map(),
    /** Customers, with the card tokens attached to each. */
    clients: new Map(),
    counter: 0,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = req.url || '';

      if (url.startsWith('/__control')) {
        const route = url.replace('/__control', '') || '/';
        if (req.method === 'GET' && route === '/state') {
          return send(200, {
            calls: state.calls.slice(-60),
            transactions: [...state.transactions].map(([id, t]) => ({ id, ...t })),
            failNext: state.failNext,
            tokenAmountOverride: state.tokenAmountOverride,
            threeDS: state.threeDS,
          });
        }
        if (req.method === 'POST' && route === '/transactions') {
          const id = body.id || `txn_ui_${++state.counter}_${crypto.randomBytes(3).toString('hex')}`;
          state.transactions.set(id, { status: body.status || 'APPROVED', amount: Number(body.amount) });
          return send(200, { id, ...state.transactions.get(id) });
        }
        if (req.method === 'POST' && route === '/fail-next') {
          state.failNext = Number(body.status) || 0;
          return send(200, { failNext: state.failNext });
        }
        if (req.method === 'POST' && route === '/token-amount-override') {
          state.tokenAmountOverride = body.amount === null || body.amount === '' ? null : Number(body.amount);
          return send(200, { tokenAmountOverride: state.tokenAmountOverride });
        }
        if (req.method === 'POST' && route === '/three-ds') {
          state.threeDS = Boolean(body.enabled);
          return send(200, { threeDS: state.threeDS });
        }
        if (req.method === 'POST' && route === '/reset') {
          state.calls.length = 0;
          state.transactions.clear();
          state.failNext = 0;
          state.tokenAmountOverride = null;
          state.threeDS = false;
          state.sessions.clear();
          state.clients.clear();
          return send(200, { reset: true });
        }
        return send(404, { message: 'unknown control route' });
      }

      const path = url.replace('/gateway-ecommerce', '').replace('/reports-sandbox', '');
      state.calls.push({
        at: new Date().toISOString(),
        method: req.method,
        path,
        authorization: req.headers.authorization || null,
        apiKey: req.headers['x-netpay-apikey'] || null,
        body,
      });
      if (state.failNext !== 0) {
        const status = state.failNext;
        state.failNext = 0;
        return send(status, { message: 'provider failure (simulated)' });
      }
      if (req.method === 'POST' && path === '/v3/token/amount') {
        const amount = state.tokenAmountOverride ?? Number(body.amount);
        state.tokenAmountOverride = null;
        return send(200, { tokenAmount: `tokenAmount_${crypto.randomBytes(6).toString('hex')}`, amount });
      }
      if (req.method === 'POST' && path === '/v3.2/checkout/session/') {
        const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
        state.sessions.set(sessionId, { merchantRefCode: body.merchantRefCode });
        return send(200, {
          id: state.sessions.size,
          sessionId,
          merchantRefCode: body.merchantRefCode,
          hostedCheckoutUrl: `https://gateway-154.netpaydev.com/hosted-checkout/session/${encodeURIComponent(sessionId)}/pk_netpay_demo`,
          paidOut: false,
        });
      }
      if (req.method === 'POST' && path === '/v4/clients') {
        const source = body.paymentSource && body.paymentSource.source;
        const id = `cus_${crypto.randomBytes(4).toString('hex')}`;
        state.clients.set(id, source ? [source] : []);
        return send(201, { id, paymentSources: source ? [{ source, type: 'card' }] : [null] });
      }
      const clientToken = /^\/v3\/clients\/([^/]+)\/token(?:\/([^/]+))?$/.exec(path);
      if (clientToken) {
        const cid = decodeURIComponent(clientToken[1]);
        const held = state.clients.get(cid);
        if (!held) return send(404, { message: 'client not found' });
        if (req.method === 'DELETE' && clientToken[2]) {
          state.clients.set(
            cid,
            held.filter((t) => t !== decodeURIComponent(clientToken[2])),
          );
          return send(200, { responseMsg: 'Token eliminado correctamente' });
        }
        if (req.method === 'PUT' && !clientToken[2]) {
          held.push(String(body.token));
          return send(200, { token: body.token, lastFourDigits: '1111', brand: 'VISA' });
        }
      }
      const clientRead = /^\/v3\/clients\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && clientRead) {
        const cid = decodeURIComponent(clientRead[1]);
        const held = state.clients.get(cid);
        if (!held) return send(404, { message: 'client not found' });
        return send(200, {
          id: cid,
          paymentSources: held.map((source) => ({ source, type: 'card', card: { lastFourDigits: '4242' } })),
        });
      }
      if (req.method === 'GET' && path === '/v3/webhooks/') return send(200, { webhook: null });
      if (req.method === 'POST' && path === '/v3.5/charges/') {
        // What the real gateway enforces: the customer must exist, the token must
        // belong to it, and a billing address must be present (else it answers 500).
        const clientId = (body.client && body.client.id) || '';
        const owned = state.clients.get(clientId);
        if (!owned) return send(404, { message: `Client not found with id : '${clientId}'` });
        if (!owned.includes(String(body.source))) return send(400, { message: 'Invalid Token' });
        if (!body.billing || !body.billing.address) return send(500, { message: 'No message available' });
        const id = `txn_charge_${++state.counter}_${crypto.randomBytes(3).toString('hex')}`;
        // The sandbox declines by e-mail: reject@netpay.com.mx answers 409 with the failed transaction.
        if (body.billing.email === 'reject@netpay.com.mx') {
          state.transactions.set(id, { status: 'REJECT', amount: Number(body.amount) });
          return send(409, {
            transactionTokenId: id,
            status: 'failed',
            error: 'Rejected by Decision Manager',
            amount: body.amount,
          });
        }
        const challenge = state.threeDS;
        state.threeDS = false;
        state.transactions.set(id, {
          status: challenge ? 'WAIT_THREEDS' : 'DONE',
          amount: Number(body.amount),
        });
        return send(200, {
          transactionTokenId: id,
          status: challenge ? 'review' : 'success',
          amount: body.amount,
          ...(challenge
            ? {
                threeDSecureResponse: {
                  status: 'PROCEED_TO_VALIDATE_AUTHENTICATION',
                  responseCode: 475,
                  acsUrl: 'https://acs.example/challenge',
                  paReq: 'paReq-demo',
                  authenticationTransactionID: 'auth-demo-1',
                },
              }
            : {}),
        });
      }
      const confirm = /^\/v3\.5\/charges\/([^/?]+)\/confirm/.exec(path);
      if (req.method === 'POST' && confirm) {
        const tx = state.transactions.get(decodeURIComponent(confirm[1]));
        if (!tx) return send(404, { message: 'transaction not found' });
        tx.status = 'DONE';
        return send(200, {});
      }
      const resolveId = /^\/v3\/get\/([^/]+)\/transactionId$/.exec(path);
      if (req.method === 'GET' && resolveId) {
        const id = decodeURIComponent(resolveId[1]);
        return state.transactions.has(id)
          ? send(200, { transactionId: `refundable_${id}` })
          : send(404, { message: 'transaction not found' });
      }
      if (req.method === 'GET' && path.startsWith('/v3/transactions/')) {
        const tx = state.transactions.get(decodeURIComponent(path.split('/').pop()));
        return tx ? send(200, tx) : send(404, { message: 'transaction not found' });
      }
      if (req.method === 'PUT' && path.startsWith('/v2/transactions/') && path.endsWith('/refund')) {
        if (!req.headers['x-netpay-apikey']) return send(401, { message: 'Please Verify your ApiKeys' });
        return send(200, {});
      }
      if (req.method === 'PUT' && path === '/v3/webhooks/') return send(200, {});
      return send(404, { message: 'No message available' });
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { startFakeNetpay };
