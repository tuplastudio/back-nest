import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Pool } from 'pg';
import { PasswordService } from '../src/auth/password.service';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';
import type { AppConfig } from '../src/config/app-config.service';

/**
 * End-to-end checks against the real Netpay sandbox.
 *
 * Runs only when `NETPAY_PK` and `NETPAY_SK` are set, so CI stays hermetic and a
 * missing key reads as "skipped" rather than "passed":
 *
 *   NETPAY_PK=pk_netpay_... NETPAY_SK=sk_netpay_... npm run test:e2e -- test/netpay-sandbox.e2e-spec.ts
 *
 * The backend is started WITHOUT `NETPAY_SANDBOX_BASE_URL`, so every provider call
 * goes to the published sandbox hosts. What can be proven without a card is
 * proven here: the key authenticates, a hosted session opens, an amount can be
 * tokenised, a customer can be created, and the calls that need a real
 * transaction are refused by Netpay in the way the code expects.
 *
 * Tokenising a card is not possible from a server (NetpayJS runs in a browser),
 * so a real charge is exercised from the test UI instead. The stand-in suite in
 * `payments.e2e-spec.ts` covers the charge, 3DS and refund logic.
 */
const PK = process.env['NETPAY_PK'];
const SK = process.env['NETPAY_SK'];
const DATABASE_URL = process.env['CONTROL_PLANE_DATABASE_URL'];
const enabled = Boolean(PK && SK && DATABASE_URL);
const suite = enabled ? describe : describe.skip;

if (!enabled) {
  // A skipped suite reads as success, so say plainly why it did not run.
  const missing = [
    ['NETPAY_PK', PK],
    ['NETPAY_SK', SK],
    ['CONTROL_PLANE_DATABASE_URL', DATABASE_URL],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  process.stderr.write(
    `\n[netpay-sandbox] SKIPPED: missing ${missing.join(', ')}.\n` +
      '  Set all three in the same shell, e.g.\n' +
      '  CONTROL_PLANE_DATABASE_URL=<disposable db> NETPAY_PK=... NETPAY_SK=... npm run test:e2e -- test/netpay-sandbox.e2e-spec.ts\n\n',
  );
}

/**
 * Fails a check with everything needed to diagnose it.
 *
 * Jest's own message only says "expected 200, received 502". The provider's
 * reason lives in the response body, so it is part of the failure text.
 *
 * @param label What was being checked.
 * @param reply The backend's answer.
 * @param extra Further context, such as the order row.
 * @returns An error to throw.
 */
function failure(label: string, reply: Reply, extra: Record<string, unknown> = {}): Error {
  return new Error(
    `${label}\n${JSON.stringify({ httpStatus: reply.status, body: reply.body, ...extra }, null, 2)}`,
  );
}

const PORT = Number(process.env['NETPAY_SANDBOX_E2E_PORT'] ?? 4011);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const RUN = randomBytes(4).toString('hex');
const SLUG = `nps-${RUN}`;
const PASSWORD = 'Sandbox-E2e-Secret!1';
const HMAC = 'sandbox-e2e-blind-index-key';
const ENC = randomBytes(32).toString('base64');

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

let server: ChildProcess;
let admin: Pool;
let tenantPool: Pool;
let pii: PiiCryptoService;
let tenantId = '';
let schema = '';
let ownerToken = '';
let platformEmail = '';

/**
 * Issues a request and decodes the JSON body.
 *
 * @param method HTTP verb.
 * @param path Path under the API prefix.
 * @param token Bearer token.
 * @param body Request body.
 * @param headers Extra headers.
 * @returns Status and body.
 */
function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      `${API}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
          ...headers,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Runs a statement inside the tenant's row-level binding.
 *
 * @param sql Statement with the schema inlined.
 * @param params Bind parameters.
 * @returns The rows.
 */
async function tenantRows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const unit = await tenantPool.connect();
  try {
    await unit.query('BEGIN');
    await unit.query(`SET LOCAL app.current_tenant = '${schema}'`);
    const res = await unit.query<T>(sql, params);
    await unit.query('COMMIT');
    return res.rows;
  } catch (error) {
    await unit.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    unit.release();
  }
}

/** Browser data NetpayJS produces during tokenisation; every charge needs it. */
const DEVICE_INFO = {
  deviceChannel: 'Browser',
  httpBrowserColorDepth: '24',
  httpBrowserJavaEnabled: 'FALSE',
  httpBrowserJavaScriptEnabled: 'TRUE',
  httpBrowserLanguage: 'es',
  httpBrowserScreenHeight: '687',
  httpBrowserScreenWidth: '1718',
  httpBrowserTimeDifference: '360',
};

suite('Netpay sandbox (real provider)', () => {
  const tenantHeader = (): Record<string, string> => ({ 'x-tenant-id': tenantId });

  beforeAll(async () => {
    const passwords = new PasswordService({
      argon2MemoryCost: 19_456,
      argon2TimeCost: 2,
      argon2Parallelism: 1,
    } as AppConfig);
    pii = new PiiCryptoService(HMAC, ENC);
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    tenantPool = new Pool({ connectionString: DATABASE_URL, max: 2 });

    const env = { ...process.env } as Record<string, string | undefined>;
    // The override that points the sandbox at a stand-in must not leak in.
    delete env['NETPAY_SANDBOX_BASE_URL'];
    delete env['NETPAY_SANDBOX_REPORTS_BASE_URL'];
    server = spawn('node', ['dist/main.js'], {
      env: {
        ...env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        API_PREFIX: 'api/v1',
        API_BASE_DOMAIN: 'api.example.com',
        DOCS_ENABLED: 'false',
        JWT_ACCESS_SECRET: 'sandbox-e2e-access-secret-at-least-32-chars',
        JWT_REFRESH_SECRET: 'sandbox-e2e-refresh-secret-at-least-32-chars',
        PII_HMAC_KEY: HMAC,
        PII_ENCRYPTION_KEY: ENC,
        OUTBOUND_WEBHOOK_ENABLED: 'false',
        THROTTLE_LIMIT: '100000',
        AUTH_THROTTLE_LIMIT: '1000',
        NETPAY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    server.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (server.exitCode !== null) {
        throw new Error(`Server exited early:\n${output.slice(-3000)}`);
      }
      try {
        const live = await new Promise<number>((resolve, reject) => {
          const r = httpRequest(`http://127.0.0.1:${PORT}/health/live`, (res) =>
            resolve(res.statusCode ?? 0),
          );
          r.on('error', reject);
          r.end();
        });
        up = live === 200;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!up) {
      throw new Error(`Server did not become healthy:\n${output.slice(-3000)}`);
    }

    platformEmail = `owner-${RUN}@sandbox.test`;
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO "platform_admins" (id,"emailCiphertext","emailLookup","emailMasked","passwordHash","displayName",role,status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'o***@sandbox.test',$3,'Sandbox Owner','OWNER','ACTIVE',now(),now()) RETURNING id`,
      [
        pii.encrypt(platformEmail, { aad: 'platform-admin.email' }),
        pii.blindIndex(platformEmail),
        await passwords.hash(PASSWORD),
      ],
    );
    await admin.query(
      `INSERT INTO "platform_admin_roles" ("adminId","roleId") SELECT $1, id FROM "roles" WHERE name = 'platform-owner'`,
      [inserted.rows[0].id],
    );
    const platform = await call('POST', '/auth/sign-in', undefined, {
      email: platformEmail,
      password: PASSWORD,
    });
    const tenant = await call('POST', '/tenants', platform.body['accessToken'] as string, {
      slug: SLUG,
      name: 'Sandbox E2E',
    });
    expect(tenant.status).toBe(201);
    tenantId = tenant.body['id'] as string;
    schema = tenant.body['schemaName'] as string;

    const ownerEmail = `tenant-owner-${RUN}@sandbox.test`;
    const unit = await tenantPool.connect();
    try {
      await unit.query('BEGIN');
      await unit.query(`SET LOCAL app.current_tenant = '${schema}'`);
      await unit.query(
        `INSERT INTO "${schema}".users (id,"emailCiphertext","emailLookup","emailMasked","passwordHash","displayName",role,status,"createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,'t***@sandbox.test',$3,'Sandbox Tenant Owner','OWNER','ACTIVE',now(),now())`,
        [
          pii.encrypt(ownerEmail, { aad: 'tenant-user.email' }),
          pii.blindIndex(ownerEmail),
          await passwords.hash(PASSWORD),
        ],
      );
      await unit.query(
        `INSERT INTO "${schema}".user_roles ("userId","roleId")
         SELECT u.id, r.id FROM "${schema}".users u, (SELECT id FROM "public"."roles" WHERE name = 'tenant-owner') r WHERE u."emailLookup" = $1`,
        [pii.blindIndex(ownerEmail)],
      );
      await unit.query('COMMIT');
    } finally {
      unit.release();
    }
    const session = await call(
      'POST',
      '/t/auth/sign-in',
      undefined,
      { email: ownerEmail, password: PASSWORD },
      tenantHeader(),
    );
    expect(session.status).toBe(200);
    ownerToken = session.body['accessToken'] as string;
  }, 120_000);

  afterAll(async () => {
    if (server !== undefined && server.exitCode === null) {
      server.kill('SIGTERM');
      let fallback: NodeJS.Timeout | undefined;
      await Promise.race([
        once(server, 'exit'),
        new Promise((r) => {
          fallback = setTimeout(r, 5_000);
        }),
      ]);
      clearTimeout(fallback);
    }
    if (admin !== undefined) {
      if (tenantId !== '') {
        await admin.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [tenantId]);
        await admin.query('DELETE FROM "payment_webhook_registry" WHERE "tenantId" = $1', [tenantId]);
        await admin.query('DELETE FROM "tenants" WHERE "id" = $1', [tenantId]);
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      const lookup = [pii.blindIndex(platformEmail)];
      await admin.query(
        'DELETE FROM "admin_refresh_tokens" WHERE "adminId" IN (SELECT id FROM "platform_admins" WHERE "emailLookup" = ANY($1))',
        [lookup],
      );
      await admin.query('DELETE FROM "platform_admins" WHERE "emailLookup" = ANY($1)', [lookup]);
      await admin.end();
    }
    await tenantPool?.end();
  }, 60_000);

  it('stores the real keys without ever returning the secret', async () => {
    const res = await call(
      'POST',
      '/t/payments/config',
      ownerToken,
      { publicKey: PK, secretKey: SK, environment: 'SANDBOX' },
      tenantHeader(),
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SK as string);
    expect(res.body['publicKey']).toBe(PK);
  });

  it('opens a Checkout Hosted session on the sandbox and returns the page Netpay hosts', async () => {
    const res = await call(
      'POST',
      '/t/payments/orders',
      ownerToken,
      {
        merchantReferenceCode: `SBX-HOSTED-${RUN}`,
        amount: '150.75',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      },
      tenantHeader(),
    );
    expect(res.status).toBe(201);
    const checkout = res.body['checkout'] as Record<string, unknown>;
    const url = String(checkout['hostedCheckoutUrl']);
    expect(url).toMatch(/^https:\/\/gateway-154\.netpaydev\.com\/hosted-checkout\/session\//);
    expect(JSON.stringify(res.body)).not.toContain(SK as string);

    const stored = await tenantRows<{ checkoutSessionId: string | null }>(
      `SELECT "checkoutSessionId" FROM "${schema}".payment_orders WHERE id = $1`,
      [res.body['id']],
    );
    expect(stored[0].checkoutSessionId).not.toBeNull();
    // Netpay percent-encodes the session id in the URL (`!` becomes `%21`).
    expect(decodeURIComponent(url)).toContain(stored[0].checkoutSessionId!);

    // The page Netpay hosts is really there.
    const page = await fetch(url, { redirect: 'manual' });
    expect(page.status).toBeLessThan(400);
  });

  it('tokenises an amount server-side and binds exactly that figure (Checkout Plus)', async () => {
    const res = await call(
      'POST',
      '/t/payments/orders',
      ownerToken,
      { merchantReferenceCode: `SBX-PLUS-${RUN}`, amount: '650.00', checkoutMode: 'plus' },
      tenantHeader(),
    );
    expect(res.status).toBe(201);
    const checkout = res.body['checkout'] as Record<string, unknown>;
    expect(typeof checkout['amountToken']).toBe('string');
    expect(String(checkout['amountToken']).length).toBeGreaterThan(8);
    expect(checkout['sandboxMode']).toBe(true);
  });

  it('creates a customer profile without a card', async () => {
    const res = await call(
      'POST',
      '/t/payments/cards',
      ownerToken,
      {
        identifier: `sbx-${RUN}`,
        firstName: 'Sandbox',
        lastName: 'Buyer',
        email: 'sandbox.buyer@example.com',
        phone: '5512345678',
      },
      tenantHeader(),
    );
    expect(res.status).toBe(201);
    expect(typeof res.body['netpayCustomerId']).toBe('string');
    expect(res.body['cardToken']).toBeNull();
  });

  it('is refused cleanly for a charge with a token Netpay never issued, and the key is accepted', async () => {
    const order = await call(
      'POST',
      '/t/payments/orders',
      ownerToken,
      { merchantReferenceCode: `SBX-CHARGE-${RUN}`, amount: '150.75', checkoutMode: 'custom' },
      tenantHeader(),
    );
    expect(order.status).toBe(201);
    const res = await call(
      'POST',
      `/t/payments/orders/${order.body['id'] as string}/charge`,
      ownerToken,
      { cardToken: 'token_neverissuedbynetpay', billing: { firstName: 'A', lastName: 'B', email: 'a@b.mx' } },
      tenantHeader(),
    );
    // Netpay refuses the token. A 401 or 403 from it would mean the key itself is
    // not accepted, which is a different problem and must not hide behind a 502.
    expect([400, 402, 404, 422, 502]).toContain(res.status);
    expect(String(JSON.stringify(res.body))).not.toMatch(/status 40[13]/);
    const row = await tenantRows<{ status: string }>(
      `SELECT status FROM "${schema}".payment_orders WHERE id = $1`,
      [order.body['id']],
    );
    expect(row[0].status).not.toBe('PAID');
  });

  /**
   * Tokenises the sandbox test card the way NetpayJS does in a browser.
   *
   * The card is Netpay's own documented sandbox card, sent to Netpay with the
   * public key; it never touches the backend under test. The expiry is in the
   * future, because the documented 04/25 is expired and Netpay refuses it.
   *
   * @returns The card token and the fingerprint used to create it.
   */
  async function tokeniseTestCard(
    cardNumber = '4000000000000002',
    cvv2 = '999',
  ): Promise<{ token: string; fingerprint: string }> {
    const fingerprint = String(Date.now());
    const res = await fetch('https://gateway-154.netpaydev.com/gateway-ecommerce/v3/token', {
      method: 'POST',
      headers: { Authorization: PK as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardNumber,
        expMonth: '12',
        expYear: '30',
        cvv2,
        vault: true,
        simpleUse: true,
        deviceFingerPrint: fingerprint,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; lastFourDigits: string };
    expect(body.lastFourDigits).toBe(cardNumber.slice(-4));
    return { token: body.token, fingerprint };
  }

  const buyer = {
    firstName: 'Test',
    lastName: 'Buyer',
    email: 'accept@netpay.com.mx',
    phone: '5512345678',
    address: {
      city: 'Monterrey',
      country: 'MX',
      postalCode: '65700',
      state: 'NLE',
      street1: 'Filosofos 100',
      street2: 'Tecnologico',
    },
  };

  let chargedOrderId = '';

  it("charges the sandbox test card and settles the order from Netpay's own answer", async () => {
    const order = await call(
      'POST',
      '/t/payments/orders',
      ownerToken,
      { merchantReferenceCode: `SBX-REAL-${RUN}`, amount: '150.75', checkoutMode: 'custom' },
      tenantHeader(),
    );
    expect(order.status).toBe(201);
    chargedOrderId = order.body['id'] as string;
    const { token, fingerprint } = await tokeniseTestCard();

    const res = await call(
      'POST',
      `/t/payments/orders/${chargedOrderId}/charge`,
      ownerToken,
      {
        cardToken: token,
        billing: buyer,
        deviceFingerPrint: fingerprint,
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
      },
      tenantHeader(),
    );
    expect(res.status).toBe(200);
    expect(res.body['status']).toBe('success');
    expect(typeof res.body['transactionTokenId']).toBe('string');
    // Netpay confirmed it to the backend, which settled the order without any notification.
    expect(res.body['orderStatus']).toBe('PAID');
    // Netpay echoes the CVV in its answer; none of that reaches the caller.
    expect(JSON.stringify(res.body)).not.toContain('999');
    expect(JSON.stringify(res.body)).not.toContain('400000');

    const row = await tenantRows<{ status: string; verifiedAmount: string; netpayTransactionId: string }>(
      `SELECT status, "verifiedAmount"::text AS "verifiedAmount", "netpayTransactionId" FROM "${schema}".payment_orders WHERE id = $1`,
      [chargedOrderId],
    );
    expect(row[0].status).toBe('PAID');
    expect(row[0].verifiedAmount).toBe('150.75');
    expect(row[0].netpayTransactionId).toBe(res.body['transactionTokenId']);
  });

  /**
   * Netpay's certification matrix ("Matriz de certificación Netpay").
   *
   * The e-mail in `billing` selects the scenario on Netpay's side: `accept@` for an
   * approval, `review@` for 3DS 2.0, `reject@` for a decline. Each card is
   * tokenised with the public key the way NetpayJS does, then charged through the
   * backend, and the order must end where the matrix says.
   *
   * The Step-Up (Challenge) rows need a person to complete the issuer page in a
   * browser, so they are exercised from the test UI and are only listed here.
   */
  describe('certification matrix', () => {
    const device = {
      deviceChannel: 'Browser',
      httpBrowserColorDepth: '24',
      httpBrowserJavaEnabled: 'FALSE',
      httpBrowserJavaScriptEnabled: 'TRUE',
      httpBrowserLanguage: 'es',
      httpBrowserScreenHeight: '687',
      httpBrowserScreenWidth: '1718',
      httpBrowserTimeDifference: '360',
    };

    const outcomes: Record<string, unknown>[] = [];
    afterAll(() => {
      // One line per row, so a run shows what passed and what did not at a glance.
      const lines = outcomes.map(
        (o) =>
          `${o['ok'] === true ? 'PASS' : 'FAIL'}  ${String(o['case']).padEnd(34)} http ${String(o['httpStatus'])}  order ${String(o['orderStatus'])}  ${JSON.stringify(o['declineReason'] ?? o['failureReason'] ?? '')}`,
      );
      process.stdout.write(`\n[certification matrix]\n${lines.join('\n')}\n\n`);
    });

    type Expect = 'paid' | 'declined' | 'frictionless';
    const rows: { name: string; card: string; email: string; expect: Expect; installments?: number }[] = [
      { name: 'Visa accepted', card: '4000000000000002', email: 'accept@netpay.com.mx', expect: 'paid' },
      {
        name: 'Mastercard accepted',
        card: '5200000000000007',
        email: 'accept@netpay.com.mx',
        expect: 'paid',
      },
      { name: 'Amex accepted', card: '340000000003961', email: 'accept@netpay.com.mx', expect: 'paid' },
      {
        name: 'Visa credit, 3 installments',
        card: '4918717162313532',
        email: 'accept@netpay.com.mx',
        expect: 'paid',
        installments: 3,
      },
      { name: 'Visa declined', card: '4000000000000002', email: 'reject@netpay.com.mx', expect: 'declined' },
      {
        name: 'Mastercard declined',
        card: '5200000000000007',
        email: 'reject@netpay.com.mx',
        expect: 'declined',
      },
      { name: 'Amex declined', card: '340000000003961', email: 'reject@netpay.com.mx', expect: 'declined' },
      {
        name: 'Visa frictionless success',
        card: '4000000000002701',
        email: 'review@netpay.com.mx',
        expect: 'frictionless',
      },
      {
        name: 'Mastercard frictionless success',
        card: '5200000000002235',
        email: 'review@netpay.com.mx',
        expect: 'frictionless',
      },
      {
        name: 'Amex frictionless success',
        card: '340000000002708',
        email: 'review@netpay.com.mx',
        expect: 'frictionless',
      },
      {
        name: 'Visa frictionless failed',
        card: '4000000000002925',
        email: 'review@netpay.com.mx',
        expect: 'declined',
      },
      {
        name: 'Mastercard frictionless failed',
        card: '5200000000002276',
        email: 'review@netpay.com.mx',
        expect: 'declined',
      },
      {
        name: 'Amex frictionless failed',
        card: '340000000002096',
        email: 'review@netpay.com.mx',
        expect: 'declined',
      },
      {
        name: 'Visa frictionless attempt',
        card: '4000000000002719',
        email: 'review@netpay.com.mx',
        expect: 'frictionless',
      },
      {
        name: 'Mastercard frictionless attempt',
        card: '5200000000002482',
        email: 'review@netpay.com.mx',
        expect: 'frictionless',
      },
      {
        name: 'Amex frictionless attempt',
        card: '340000000002872',
        email: 'review@netpay.com.mx',
        expect: 'frictionless',
      },
    ];

    it.each(rows)('$name', async (row) => {
      const amount = row.installments === undefined ? '150.75' : '650.00';
      const order = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: `CERT-${row.card.slice(-4)}-${RUN}`, amount, checkoutMode: 'custom' },
        tenantHeader(),
      );
      expect(order.status).toBe(201);
      const id = order.body['id'] as string;
      const amex = row.card.startsWith('34');
      const { token, fingerprint } = await tokeniseTestCard(row.card, amex ? '9999' : '999');
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        {
          cardToken: token,
          billing: { ...buyer, email: row.email },
          deviceFingerPrint: fingerprint,
          deviceInformation: device,
          ...(row.installments === undefined ? {} : { installments: row.installments }),
        },
        tenantHeader(),
      );
      // Frictionless: Netpay answers `review` with a 3DS block that has no ACS URL
      // (responseCode 100). The library's `canProceed` is false, so the storefront
      // confirms with a null processor id, which is what is done here.
      const challenge = res.body['threeDSecureResponse'] as Record<string, unknown> | undefined;
      let confirmed: Reply | null = null;
      if (row.expect === 'frictionless' && challenge !== undefined && !challenge['acsUrl']) {
        confirmed = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          ownerToken,
          { processorTransactionId: null },
          tenantHeader(),
        );
      }
      const rows2 = await tenantRows<{ status: string; failureReason: string | null }>(
        `SELECT status, "failureReason" FROM "${schema}".payment_orders WHERE id = $1`,
        [id],
      );
      const final = rows2[0].status;
      const context = {
        case: row.name,
        card: `…${row.card.slice(-4)}`,
        email: row.email,
        orderStatus: final,
        failureReason: rows2[0].failureReason,
        declineReason: res.body['declineReason'],
        confirm: confirmed === null ? null : { status: confirmed.status, body: confirmed.body },
      };
      let ok: boolean;
      if (row.expect === 'paid') {
        ok = res.status === 200 && final === 'PAID';
      } else if (row.expect === 'declined') {
        // A decline is a charge outcome: 200, the order FAILED, never settled.
        ok = res.status === 200 && final === 'FAILED';
      } else {
        ok = res.status === 200 && confirmed?.status === 200 && final === 'PAID';
      }
      outcomes.push({ ...context, expected: row.expect, httpStatus: res.status, ok });
      if (!ok) {
        throw failure(`Matrix row failed: ${row.name} (expected ${row.expect})`, res, context);
      }
    });
  });

  it('refuses to charge an order that is already settled', async () => {
    const { token } = await tokeniseTestCard();
    const res = await call(
      'POST',
      `/t/payments/orders/${chargedOrderId}/charge`,
      ownerToken,
      {
        cardToken: token,
        billing: buyer,
        deviceFingerPrint: String(Date.now()),
        deviceInformation: DEVICE_INFO,
      },
      tenantHeader(),
    );
    expect(res.status).toBe(409);
  });

  it('reverses the settled charge, or is told by Netpay that the merchant lacks the operation', async () => {
    const res = await call(
      'POST',
      `/t/payments/orders/${chargedOrderId}/refund`,
      ownerToken,
      { motive: 'integration test' },
      tenantHeader(),
    );
    const row = await tenantRows<{ status: string }>(
      `SELECT status FROM "${schema}".payment_orders WHERE id = $1`,
      [chargedOrderId],
    );
    if (res.status === 200) {
      expect(res.body['status']).toBe('REFUNDED');
      expect(row[0].status).toBe('REFUNDED');
    } else {
      // Netpay disables refunds per merchant until a sales advisor enables them.
      // That is a provider answer, not an integration fault: the order must be
      // left settled and the call must read as an upstream error.
      expect(res.status).toBe(502);
      expect(row[0].status).toBe('PAID');
    }
  });

  it('does not settle an order from a notification for a transaction Netpay does not know', async () => {
    const created = await call(
      'POST',
      '/t/payments/orders',
      ownerToken,
      { merchantReferenceCode: `SBX-FORGED-${RUN}`, amount: '150.75' },
      tenantHeader(),
    );
    expect(created.status).toBe(201);
    const rotated = await call(
      'POST',
      '/t/payments/config/webhook-token',
      ownerToken,
      undefined,
      tenantHeader(),
    );
    const token = rotated.body['token'] as string;
    const row = await tenantRows<{ checkoutSessionId: string }>(
      `SELECT "checkoutSessionId" FROM "${schema}".payment_orders WHERE id = $1`,
      [created.body['id']],
    );
    const res = await call('POST', `/payments/webhook/${token}`, undefined, {
      event: 'sessionLink.paid',
      data: {
        sessionId: row[0].checkoutSessionId,
        transactionId: 'ffffffff-0000-4000-8000-000000000000',
        amount: '150.75',
        status: 'DONE',
      },
      type: null,
      createdAt: Date.now(),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 4_000));
    const after = await tenantRows<{ status: string; netpayTransactionId: string | null }>(
      `SELECT status, "netpayTransactionId" FROM "${schema}".payment_orders WHERE id = $1`,
      [created.body['id']],
    );
    expect(after[0].status).toBe('PENDING');
    expect(after[0].netpayTransactionId).toBeNull();
  });

  it('answers 502, not 401, when asked to refund a transaction Netpay does not know', async () => {
    // A settled order is seeded directly: a real payment needs a card.
    const id = (
      await tenantRows<{ id: string }>(
        `INSERT INTO "${schema}".payment_orders (id,"tenantId","orderReference","merchantReferenceCode",amount,status,"netpayTransactionId","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$2,150.75,'PAID','00000000-0000-4000-8000-000000000001',now(),now()) RETURNING id`,
        [tenantId, `SBX-REFUND-${RUN}`],
      )
    )[0].id;
    const res = await call(
      'POST',
      `/t/payments/orders/${id}/refund`,
      ownerToken,
      { motive: 'sandbox e2e' },
      tenantHeader(),
    );
    expect(res.status).toBe(502);
    expect(String(JSON.stringify(res.body))).not.toMatch(/status 40[13]/);
    const row = await tenantRows<{ status: string }>(
      `SELECT status FROM "${schema}".payment_orders WHERE id = $1`,
      [id],
    );
    expect(row[0].status).toBe('PAID');
  });
});
