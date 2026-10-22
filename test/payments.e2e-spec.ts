import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Pool } from 'pg';
import { PasswordService } from '../src/auth/password.service';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';
import { TenantSchemaNamingService } from '../src/tenancy/tenant-schema-naming.service';
import type { AppConfig } from '../src/config/app-config.service';

/**
 * End-to-end coverage for payments and outbound webhooks.
 *
 * The suite is split in two on purpose.
 *
 * Everything that does not depend on the provider runs unconditionally: RBAC on
 * the credential routes, that the secret never leaves, that a forged inbound
 * notification changes nothing, and that a tenant-supplied destination is
 * refused. Those are the properties that matter most, and they must not depend
 * on somebody having Netpay credentials.
 *
 * The provider round trip runs against a local stand-in for Netpay. The server
 * is pointed at it through `NETPAY_SANDBOX_BASE_URL`, which the application
 * honours only when `NODE_ENV` is `test`. That keeps CI hermetic and lets every
 * path be exercised, including the ones a real sandbox cannot be made to take:
 * a declined charge, an amount that does not match, a provider outage.
 */

const PORT = Number(process.env['PAYMENTS_E2E_PORT'] ?? 4010);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `${BASE_URL}/api/v1`;
const DATABASE_URL = process.env['CONTROL_PLANE_DATABASE_URL'];

const RUN_ID = randomBytes(4).toString('hex');
/** Billing data a charge needs: Netpay answers 500 without an address and cannot create the customer without a phone. */
const BILLING = {
  firstName: 'Ana',
  lastName: 'Lopez',
  email: 'ana@example.mx',
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
/** Browser data from Netpay tokenisation, which a charge requires for 3-D Secure 2.0. */
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
const SLUG = `pay-${RUN_ID}`;
const ADMIN_PASSWORD = 'Payments-E2e-Secret!1';
const TENANT_PASSWORD = 'Tenant-E2e-Secret!1';

let server: ChildProcess;
let providerServer: Server;
let providerUrl = '';

/** One request the stand-in provider received. */
interface ProviderCall {
  method: string;
  path: string;
  authorization: string | undefined;
  /** Value of `X-Netpay-Apikey`, the header the reports service reads. */
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

/** State of the stand-in provider, reset between tests that care. */
const provider = {
  calls: [] as ProviderCall[],
  transactions: new Map<string, { status: string; amount: number }>(),
  /** Status to answer the next provider request with, then cleared. */
  failNext: 0,
  /** Amount to bind to the next amount token instead of the requested one. */
  tokenAmountOverride: null as number | null,
  /** Status a new charge is created with. `review` is what Netpay answers when it wants 3DS. */
  chargeStatus: 'DONE',
  /** When set, a charge answers with a 3-D Secure challenge and waits for confirmation. */
  threeDS: false,
  /** When set, the next charge is declined the way the sandbox does it: 409 with the transaction. */
  declineNext: false,
  /** Status to answer the next CHARGE with (not the customer creation before it), then cleared. */
  failChargeNext: 0,
  /** Requests whose path matches are answered only after `delayMs` (to make requests overlap). */
  delayPath: null as RegExp | null,
  delayMs: 0,
  /** Customers the stand-in has created, with the card tokens attached to each. */
  clients: new Map<string, string[]>(),
  /** Hosted sessions the stand-in has issued, keyed by session id. */
  sessions: new Map<string, { merchantRefCode: string; amount: string }>(),
  /** The webhook URL registered with `PUT /v3/webhooks/`, answered by `GET` (drift, BN-TASK-026). */
  registeredWebhook: null as string | null,
  counter: 0,
};

/**
 * Starts a stand-in for the Netpay gateway on a free local port.
 */
async function startProvider(): Promise<void> {
  providerServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        body = {};
      }
      const path = (req.url ?? '').replace('/gateway-ecommerce', '').replace('/reports-sandbox', '');
      const headers = req.headers;
      const method = req.method ?? 'GET';
      provider.calls.push({
        method,
        path,
        authorization: headers.authorization,
        apiKey: headers['x-netpay-apikey'] as string | undefined,
        body,
      });
      const delay = provider.delayPath !== null && provider.delayPath.test(path) ? provider.delayMs : 0;
      const reply = (status: number, payload: unknown): void => {
        setTimeout(() => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        }, delay);
      };
      if (provider.failNext !== 0) {
        const status = provider.failNext;
        provider.failNext = 0;
        reply(status, { message: 'provider failure' });
        return;
      }
      if (method === 'POST' && path === '/v3/token/amount') {
        const amount = provider.tokenAmountOverride ?? Number(body['amount']);
        provider.tokenAmountOverride = null;
        reply(200, { tokenAmount: `tokenAmount_${randomBytes(6).toString('hex')}`, amount });
        return;
      }
      if (method === 'POST' && path === '/v4/clients') {
        const source = (body['paymentSource'] as Record<string, unknown> | undefined)?.['source'];
        const id = `cus_${randomBytes(4).toString('hex')}`;
        provider.clients.set(id, typeof source === 'string' ? [source] : []);
        reply(201, {
          id,
          paymentSources: typeof source === 'string' ? [{ source, type: 'card' }] : [null],
        });
        return;
      }
      const clientToken = /^\/v3\/clients\/([^/]+)\/token(?:\/([^/]+))?$/.exec(path);
      if (clientToken !== null) {
        const owned = provider.clients.get(decodeURIComponent(clientToken[1]));
        if (owned === undefined) {
          reply(404, { message: 'client not found' });
          return;
        }
        if (method === 'DELETE' && clientToken[2] !== undefined) {
          const token = decodeURIComponent(clientToken[2]);
          if (!owned.includes(token)) {
            reply(404, { message: 'CardTokenAndClientId not found' });
            return;
          }
          provider.clients.set(
            decodeURIComponent(clientToken[1]),
            owned.filter((t) => t !== token),
          );
          reply(200, { responseMsg: 'Token eliminado correctamente' });
          return;
        }
        if (method === 'PUT' && clientToken[2] === undefined) {
          owned.push(String(body['token']));
          reply(200, {
            token: body['token'],
            lastFourDigits: '1111',
            brand: 'VISA',
            cardHolderName: 'Ana Lopez',
            ipAddress: '10.0.0.9',
          });
          return;
        }
      }
      const clientRead = /^\/v3\/clients\/([^/]+)$/.exec(path);
      if (method === 'GET' && clientRead !== null) {
        const id = decodeURIComponent(clientRead[1]);
        const owned = provider.clients.get(id);
        if (owned === undefined) {
          reply(404, { message: 'client not found' });
          return;
        }
        reply(200, {
          id,
          identifier: 'buyer',
          paymentSources: owned.map((source) => ({ source, type: 'card', card: { lastFourDigits: '4242' } })),
        });
        return;
      }
      if (method === 'POST' && path === '/v3.2/checkout/session/') {
        const sessionId = `sess_${randomBytes(8).toString('hex')}`;
        const line = (body['lineItems'] as { amount: string }[] | undefined)?.[0];
        provider.sessions.set(sessionId, {
          merchantRefCode: String(body['merchantRefCode']),
          amount: line?.amount ?? '0',
        });
        reply(200, {
          id: provider.sessions.size,
          sessionId,
          merchantRefCode: body['merchantRefCode'],
          hostedCheckoutUrl: `https://gateway-154.netpaydev.com/hosted-checkout/session/${sessionId}/pk_netpay_x`,
          paidOut: false,
        });
        return;
      }
      if (method === 'POST' && path === '/v3.5/charges/' && provider.failChargeNext !== 0) {
        // The charge itself fails without a definitive answer: Netpay may or may not have charged.
        const status = provider.failChargeNext;
        provider.failChargeNext = 0;
        reply(status, { message: 'provider failure' });
        return;
      }
      if (method === 'POST' && path === '/v3.5/charges/') {
        // What the real gateway enforces, found by probing the sandbox: the
        // customer must exist, the token must belong to it, and a billing
        // address must be present (without one the gateway answers 500).
        const clientId = (body['client'] as { id?: string } | undefined)?.id ?? '';
        const owned = provider.clients.get(clientId);
        if (owned === undefined) {
          reply(404, { message: `Client not found with id : '${clientId}'` });
          return;
        }
        if (!owned.includes(String(body['source']))) {
          reply(400, { message: 'Invalid Token' });
          return;
        }
        const billing = body['billing'] as { address?: unknown } | undefined;
        if (billing?.address === undefined) {
          reply(500, { message: 'No message available' });
          return;
        }
        provider.counter += 1;
        const id = `txn_charge_${RUN_ID}_${provider.counter}`;
        if (provider.declineNext) {
          provider.declineNext = false;
          provider.transactions.set(id, { status: 'REJECT', amount: Number(body['amount']) });
          reply(409, {
            transactionTokenId: id,
            status: 'failed',
            error: 'Rejected by Decision Manager',
            amount: body['amount'],
          });
          return;
        }
        const status = provider.threeDS ? 'WAIT_THREEDS' : provider.chargeStatus;
        provider.transactions.set(id, { status, amount: Number(body['amount']) });
        reply(200, {
          transactionTokenId: id,
          status: provider.threeDS ? 'review' : 'success',
          amount: body['amount'],
          ...(provider.threeDS
            ? {
                threeDSecureResponse: {
                  status: 'PROCEED_TO_VALIDATE_AUTHENTICATION',
                  responseCode: 475,
                  acsUrl: 'https://acs.example/challenge',
                  paReq: 'paReq-value',
                  authenticationTransactionID: 'auth-tx-1',
                },
              }
            : {}),
        });
        return;
      }
      const confirm = /^\/v3\.5\/charges\/([^/]+)\/confirm/.exec(path);
      if (method === 'POST' && confirm !== null) {
        const tx = provider.transactions.get(decodeURIComponent(confirm[1]));
        if (tx === undefined) {
          reply(404, { message: 'not found' });
          return;
        }
        tx.status = 'DONE';
        reply(200, {});
        return;
      }
      const resolveId = /^\/v3\/get\/([^/]+)\/transactionId$/.exec(path);
      if (method === 'GET' && resolveId !== null) {
        const id = decodeURIComponent(resolveId[1]);
        if (!provider.transactions.has(id)) {
          reply(404, { message: 'transaction not found' });
          return;
        }
        reply(200, { transactionId: `refundable_${id}` });
        return;
      }
      if (method === 'GET' && path.startsWith('/v3/transactions/')) {
        const tx = provider.transactions.get(decodeURIComponent(path.slice('/v3/transactions/'.length)));
        if (tx === undefined) {
          reply(404, { message: 'not found' });
          return;
        }
        reply(200, { status: tx.status, amount: tx.amount });
        return;
      }
      if (method === 'PUT' && path.startsWith('/v2/transactions/') && path.endsWith('/refund')) {
        // The reports service reads X-Netpay-Apikey; without it Netpay answers 401.
        if (headers['x-netpay-apikey'] === undefined) {
          reply(401, { message: 'Please Verify your ApiKeys' });
          return;
        }
        reply(200, {});
        return;
      }
      if (method === 'PUT' && path === '/v3/webhooks/') {
        provider.registeredWebhook = typeof body['webhook'] === 'string' ? body['webhook'] : null;
        reply(200, {});
        return;
      }
      if (method === 'GET' && path === '/v3/webhooks/') {
        // The read-only call that proves a key before it is stored, and what the
        // drift check reads.
        reply(headers['authorization'] === undefined ? 401 : 200, { webhook: provider.registeredWebhook });
        return;
      }
      reply(404, { message: 'No message available' });
    });
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  providerUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/gateway-ecommerce`;
}
let adminPool: Pool;
let tenantPool: Pool;
let crypto: PiiCryptoService;
let naming: TenantSchemaNamingService;
let passwords: PasswordService;

let adminAccessToken = '';
let auditorAccessToken = '';
let viewerAccessToken = '';
let tenantAId = '';
let tenantASchema = '';
let ownerToken = '';
let tenantAdminToken = '';
let webhookToken = '';

type TenantMember = 'OWNER' | 'ADMIN' | 'VIEWER';
const TENANT_ROLE: Record<TenantMember, string> = {
  OWNER: 'tenant-owner',
  ADMIN: 'tenant-admin',
  VIEWER: 'tenant-viewer',
};

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Issues a request and decodes the JSON body.
 *
 * @param method HTTP verb.
 * @param path Path relative to the API root.
 * @param token Bearer token, when the route needs one.
 * @param body Request body.
 * @param headers Extra headers.
 * @returns Status and decoded body.
 */
async function call(
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
        timeout: 20_000,
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
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
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
 * Issues a request outside the versioned prefix.
 *
 * Health probes are mounted at the root, not under `/api/v1`, so an orchestrator
 * never needs to know the API version.
 *
 * @param path Path relative to the server root.
 * @returns Status and decoded body.
 */
async function root(path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${BASE_URL}${path}`,
      { method: 'GET', headers: { 'content-type': 'application/json' }, timeout: 15_000 },
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
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Starts the built server with a hermetic environment.
 */
async function startServer(): Promise<void> {
  server = spawn('node', [process.env['PAYMENTS_E2E_ENTRY'] ?? 'dist/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      API_PREFIX: 'api/v1',
      API_BASE_DOMAIN: 'api.example.com',
      DOCS_ENABLED: 'false',
      JWT_ACCESS_SECRET: process.env['JWT_ACCESS_SECRET'] ?? 'pay-e2e-access-secret-at-least-32-chars',
      JWT_REFRESH_SECRET: process.env['JWT_REFRESH_SECRET'] ?? 'pay-e2e-refresh-secret-at-least-32-chars',
      PII_HMAC_KEY: process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key',
      PII_ENCRYPTION_KEY: process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
      // No provider contact: the outbound queue is exercised with fake endpoints
      // that never resolve, which is the path the tests care about.
      OUTBOUND_WEBHOOK_ENABLED: 'false',
      // Hundreds of requests from one address: the default limit would answer 429.
      THROTTLE_LIMIT: '100000',
      AUTH_THROTTLE_LIMIT: '1000',
      NETPAY_SANDBOX_BASE_URL: providerUrl,
      NETPAY_SANDBOX_REPORTS_BASE_URL: providerUrl.replace('/gateway-ecommerce', '/reports-sandbox'),
      NETPAY_ENCRYPTION_KEY: process.env['NETPAY_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
      // The drift check compares Netpay's registration against this (BN-TASK-026).
      PUBLIC_BASE_URL: 'https://api.example.com',
      // The worker is exercised by test/reconciliation.int-spec.ts; here it would
      // only race the assertions. POST /internal/tick still answers.
      RECONCILE_ENABLED: 'false',
      INTERNAL_TICK_SA_EMAIL: 'netpay-tick@example-project.iam.gserviceaccount.com',
      INTERNAL_TICK_AUDIENCE: 'https://api.example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Captured rather than discarded: a server that refuses to start must say why,
  // and "did not become healthy" on its own is not a diagnosable failure.
  let output = '';
  server.stdout?.on('data', (c: Buffer) => {
    output += c.toString();
  });
  server.stderr?.on('data', (c: Buffer) => {
    output += c.toString();
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited early with code ${server.exitCode}. Output:\n${output.slice(-4000)}`);
    }
    try {
      const res = await root('/health/live');
      if (res.status === 200) {
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become healthy in time. Output:\n${output.slice(-4000)}`);
}

/**
 * Stops the server.
 */
async function stopServer(): Promise<void> {
  if (server === undefined || server.exitCode !== null) {
    return;
  }
  server.kill('SIGTERM');
  // The fallback timer is cleared once the process exits: left running it keeps
  // Jest alive for the full five seconds after the suite has finished.
  let fallback: NodeJS.Timeout | undefined;
  await Promise.race([
    once(server, 'exit'),
    new Promise((r) => {
      fallback = setTimeout(r, 5_000);
    }),
  ]);
  clearTimeout(fallback);
}

/**
 * Creates a platform administrator with the given role and returns its token.
 *
 * @param role Platform role to grant.
 * @returns An access token for that administrator.
 */
async function adminTokenFor(role: 'OWNER' | 'AUDITOR'): Promise<string> {
  const email = `${role.toLowerCase()}-${RUN_ID}@example.test`;
  if (crypto === undefined) {
    // Constructed from the same environment the server runs with, so the harness
    // encrypts exactly what the application will be able to decrypt.
    const hmacKey = process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key';
    const encryptionKey = process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64');
    crypto = new PiiCryptoService(hmacKey, encryptionKey);
  }
  const inserted = await adminPool.query<{ id: string }>(
    `INSERT INTO "platform_admins" (id,"emailCiphertext","emailLookup","emailMasked","passwordHash","displayName",role,status,"createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'ACTIVE',now(),now()) RETURNING id`,
    [
      crypto.encrypt(email, { aad: 'platform-admin.email' }),
      crypto.blindIndex(email),
      'p***e@example.test',
      await passwords.hash(ADMIN_PASSWORD),
      `Payments E2E ${role}`,
      role,
    ],
  );
  // Authority comes from the RBAC catalogue, not from the `role` column: an
  // administrator with no role assigned holds no permission at all.
  await adminPool.query(
    `INSERT INTO "platform_admin_roles" ("adminId","roleId")
     SELECT $1, id FROM "roles" WHERE name = $2`,
    [inserted.rows[0].id, role === 'OWNER' ? 'platform-owner' : 'platform-auditor'],
  );
  const res = await call('POST', '/auth/sign-in', undefined, { email, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return res.body['accessToken'] as string;
}

/**
 * Creates a tenant member with the given role and returns its token.
 *
 * @param role Tenant role to grant.
 * @returns An access token for that member.
 */
async function tenantTokenFor(role: TenantMember): Promise<string> {
  const email = `${role.toLowerCase()}-${RUN_ID}@acme.test`;
  const res = await call(
    'POST',
    '/t/auth/sign-in',
    undefined,
    { email, password: TENANT_PASSWORD },
    { 'x-tenant-slug': SLUG },
  );
  if (res.status !== 200) {
    throw new Error(`sign-in failed: ${JSON.stringify(res.body)}`);
  }
  return res.body['accessToken'] as string;
}

/**
 * Builds the PII service, once.
 *
 * Constructed from the same environment the server runs with, so the harness
 * encrypts exactly what the application will be able to decrypt.
 *
 * @returns The crypto service.
 */
function ensureCrypto(): PiiCryptoService {
  if (crypto === undefined) {
    const hmacKey = process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key';
    const encryptionKey = process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64');
    crypto = new PiiCryptoService(hmacKey, encryptionKey);
  }
  return crypto;
}

/**
 * Seeds a tenant member straight into a tenant schema.
 *
 * Creating members through the API needs an existing member session, which is
 * not what these tests are about: they are about what a member may reach.
 *
 * @param schema Tenant schema; validated as an identifier before it is inlined.
 * @param email Address the member will sign in with.
 * @param displayName Name shown in the console.
 * @param role Permission set to grant.
 */
async function seedTenantUser(
  schema: string,
  email: string,
  displayName: string,
  role: TenantMember,
): Promise<void> {
  const c = ensureCrypto();
  const roleRow = await adminPool.query<{ id: string }>('SELECT id FROM "roles" WHERE name = $1', [
    TENANT_ROLE[role],
  ]);
  const hash = await passwords.hash(TENANT_PASSWORD);
  // `SET LOCAL` cannot take a bind parameter, which is the same constraint the
  // application documents. The name is a validated identifier first, so
  // inlining it here is the sanctioned form rather than a shortcut.
  expect(naming.isValidSchemaName(schema)).toBe(true);
  // One connection for the whole unit of work: the row-level binding is
  // transaction-scoped, and a prepared statement cannot carry several
  // commands at once.
  const unit = await tenantPool.connect();
  try {
    await unit.query('BEGIN');
    await unit.query(`SET LOCAL app.current_tenant = '${schema}'`);
    await unit.query(
      `INSERT INTO "${schema}".users (id,"emailCiphertext","emailLookup","emailMasked","passwordHash","displayName",role,status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'m***r@acme.test',$3,$4,$5,'ACTIVE',now(),now())`,
      [c.encrypt(email, { aad: 'tenant-user.email' }), c.blindIndex(email), hash, displayName, role],
    );
    await unit.query(
      `INSERT INTO "${schema}".user_roles ("userId","roleId")
       SELECT id, $2::uuid FROM "${schema}".users WHERE "emailLookup" = $1`,
      [c.blindIndex(email), roleRow.rows[0].id],
    );
    await unit.query('COMMIT');
  } catch (error) {
    await unit.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    unit.release();
  }
}

/** A tenant of its own, with a member who may sign in as it. */
interface RivalTenant {
  id: string;
  schema: string;
  slug: string;
  /** A token issued to that tenant's OWNER, not a platform administrator's. */
  token: string;
}

/**
 * Creates a second tenant with an OWNER of its own.
 *
 * A rival tenant is what makes an isolation test mean something. A platform
 * administrator may address any tenant by design, so reading another tenant's
 * orders with an administrator token proves nothing at all. The caller in these
 * tests is an OWNER of a different tenant, holding a token that tenant issued:
 * the one principal that genuinely has no business here.
 *
 * @param slug Slug for the new tenant.
 * @returns Its id, schema, and a token for its OWNER.
 */
async function createRivalTenant(slug: string): Promise<RivalTenant> {
  const created = await call('POST', '/tenants', adminAccessToken, { slug, name: 'Payments E2E Rival' });
  expect(created.status).toBe(201);
  const id = created.body['id'] as string;
  const schema = created.body['schemaName'] as string;
  const email = `owner-${RUN_ID}-${slug}@rival.test`;
  await seedTenantUser(schema, email, 'Rival Owner', 'OWNER');
  const signedIn = await call(
    'POST',
    '/t/auth/sign-in',
    undefined,
    { email, password: TENANT_PASSWORD },
    { 'x-tenant-slug': slug },
  );
  if (signedIn.status !== 200) {
    throw new Error(`rival sign-in failed: ${JSON.stringify(signedIn.body)}`);
  }
  return { id, schema, slug, token: signedIn.body['accessToken'] as string };
}

/**
 * Removes a tenant and everything that belongs to it.
 *
 * @param id Tenant id.
 * @param schema Tenant schema.
 */
async function destroyRivalTenant(id: string, schema: string): Promise<void> {
  await adminPool.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [id]);
  await adminPool.query('DELETE FROM "payment_webhook_registry" WHERE "tenantId" = $1', [id]);
  await adminPool.query('DELETE FROM "tenants" WHERE "id" = $1', [id]);
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

describe('payments and outbound webhooks (e2e)', () => {
  beforeAll(async () => {
    if (DATABASE_URL === undefined) {
      throw new Error('CONTROL_PLANE_DATABASE_URL is required.');
    }
    // `PasswordService` reads only the Argon2 cost parameters, so a partial
    // config is enough to seed the accounts this suite signs in as.
    passwords = new PasswordService({
      argon2MemoryCost: 19_456,
      argon2TimeCost: 2,
      argon2Parallelism: 1,
    } as AppConfig);
    naming = new TenantSchemaNamingService();
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    tenantPool = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await startProvider();
    await startServer();

    adminAccessToken = await adminTokenFor('OWNER');
    auditorAccessToken = await adminTokenFor('AUDITOR');

    // A tenant with one OWNER and one VIEWER, created through the real API so the
    // provisioning path and its migrations run.
    const created = await call('POST', '/tenants', adminAccessToken, {
      slug: SLUG,
      name: 'Payments E2E',
    });
    expect(created.status).toBe(201);
    tenantAId = created.body['id'] as string;
    tenantASchema = created.body['schemaName'] as string;
    expect(naming.isValidSchemaName(tenantASchema)).toBe(true);

    // Seed the three members directly: creating them through the API needs a
    // member session, and this test is about authorization, not sign-up.
    for (const role of ['OWNER', 'ADMIN', 'VIEWER'] as const) {
      await seedTenantUser(
        tenantASchema,
        `${role.toLowerCase()}-${RUN_ID}@acme.test`,
        `Payments ${role}`,
        role,
      );
    }
    viewerAccessToken = await tenantTokenFor('VIEWER');
    ownerToken = await tenantTokenFor('OWNER');
    tenantAdminToken = await tenantTokenFor('ADMIN');
  }, 120_000);

  afterAll(async () => {
    await stopServer();
    await new Promise<void>((resolve) =>
      providerServer === undefined ? resolve() : providerServer.close(() => resolve()),
    );
    if (adminPool !== undefined) {
      const rows = await adminPool.query<{ id: string; schemaName: string }>(
        `SELECT "id", "schemaName" FROM "tenants" WHERE "slug" = $1`,
        [SLUG],
      );
      for (const row of rows.rows) {
        await adminPool.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [row.id]);
        await adminPool.query('DELETE FROM "payment_webhook_registry" WHERE "tenantId" = $1', [row.id]);
        await adminPool.query('DELETE FROM "tenants" WHERE "id" = $1', [row.id]);
        await adminPool.query(`DROP SCHEMA IF EXISTS "${row.schemaName}" CASCADE`);
      }
      await adminPool.query(
        `DELETE FROM "admin_refresh_tokens" WHERE "adminId" IN
           (SELECT id FROM "platform_admins" WHERE "emailLookup" = ANY($1))`,
        [[`owner-${RUN_ID}@example.test`, `auditor-${RUN_ID}@example.test`].map((e) => crypto.blindIndex(e))],
      );
      if (crypto !== undefined) {
        await adminPool.query('DELETE FROM "platform_admins" WHERE "emailLookup" = ANY($1)', [
          [`owner-${RUN_ID}@example.test`, `auditor-${RUN_ID}@example.test`].map((e) => crypto.blindIndex(e)),
        ]);
      }
      await adminPool.end();
    }
    await tenantPool?.end();
  }, 60_000);

  /** Header that addresses the tenant under test. */
  const tenantHeader = (): Record<string, string> => ({ 'x-tenant-id': tenantAId });
  const VALID_CONFIG = {
    publicKey: 'pk_netpay_e2enotarealkey',
    secretKey: 'sk_netpay_e2enotarealkey',
    environment: 'SANDBOX',
  };

  /**
   * Seeds a PENDING order straight into the tenant schema, so notification and
   * state-machine tests do not depend on the provider.
   *
   * @param reference Order reference.
   * @returns The new order id.
   */
  async function seedOrder(reference: string): Promise<string> {
    const unit = await tenantPool.connect();
    try {
      await unit.query('BEGIN');
      await unit.query(`SET LOCAL app.current_tenant = '${tenantASchema}'`);
      const row = await unit.query<{ id: string }>(
        `INSERT INTO "${tenantASchema}".payment_orders (id,"tenantId","orderReference","merchantReferenceCode",amount,status,"createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$2,650.00,'PENDING',now(),now()) RETURNING id`,
        [tenantAId, reference],
      );
      await unit.query('COMMIT');
      return row.rows[0].id;
    } catch (error) {
      await unit.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      unit.release();
    }
  }

  /**
   * Reads rows from the tenant schema under its row-level binding.
   *
   * @param sql Statement, with the schema already inlined.
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
      await unit.query(`SET LOCAL app.current_tenant = '${tenantASchema}'`);
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

  describe('authentication and tenant scoping', () => {
    it('refuses every payment route without a token', async () => {
      for (const [method, path] of [
        ['GET', '/t/payments/orders'],
        ['POST', '/t/payments/orders'],
        ['POST', '/t/payments/config'],
        ['GET', '/t/webhooks'],
      ] as const) {
        const res = await call(method, path, undefined, undefined, tenantHeader());
        expect(res.status).toBe(401);
      }
    });

    it('answers 400 when no tenant is addressed', async () => {
      const res = await call('GET', '/t/payments/installments', adminAccessToken);
      expect(res.status).toBe(400);
    });
  });

  describe('authorization on payment routes', () => {
    it('refuses a read-only AUDITOR from storing provider credentials', async () => {
      const res = await call('POST', '/t/payments/config', auditorAccessToken, VALID_CONFIG, tenantHeader());
      expect(res.status).toBe(403);
    });

    it('refuses a read-only tenant VIEWER from storing provider credentials', async () => {
      const res = await call('POST', '/t/payments/config', viewerAccessToken, VALID_CONFIG, tenantHeader());
      expect(res.status).toBe(403);
    });

    it('refuses a VIEWER every payment operation', async () => {
      const gets = await call('GET', '/t/payments/orders', viewerAccessToken, undefined, tenantHeader());
      expect(gets.status).toBe(403);
      const create = await call(
        'POST',
        '/t/payments/orders',
        viewerAccessToken,
        { merchantReferenceCode: 'X', amount: '10.00' },
        tenantHeader(),
      );
      expect(create.status).toBe(403);
      const refund = await call(
        'POST',
        '/t/payments/orders/00000000-0000-0000-0000-000000000000/refund',
        viewerAccessToken,
        undefined,
        tenantHeader(),
      );
      expect(refund.status).toBe(403);
    });

    it('lets an AUDITOR read but not write payments', async () => {
      const read = await call(
        'GET',
        '/t/payments/installments',
        auditorAccessToken,
        undefined,
        tenantHeader(),
      );
      expect(read.status).toBe(200);
      const write = await call(
        'POST',
        '/t/payments/orders',
        auditorAccessToken,
        { merchantReferenceCode: 'X', amount: '10.00' },
        tenantHeader(),
      );
      expect(write.status).toBe(403);
    });

    it('refuses a VIEWER from registering an outbound destination', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        viewerAccessToken,
        { url: 'https://hooks.example.com/payments', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(res.status).toBe(403);
    });

    it('keeps outbound destinations away from a tenant ADMIN, who may configure payments', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        tenantAdminToken,
        { url: 'https://hooks.example.com/payments', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(res.status).toBe(403);
    });

    it('does not let the tenant token address another tenant by header', async () => {
      const res = await call('GET', '/t/payments/orders', ownerToken, undefined, {
        'x-tenant-id': '00000000-0000-4000-8000-000000000000',
      });
      expect([400, 401, 403, 404]).toContain(res.status);
    });
  });

  describe('credential handling', () => {
    it('rejects a key that is not shaped like one', async () => {
      const res = await call(
        'POST',
        '/t/payments/config',
        ownerToken,
        { ...VALID_CONFIG, publicKey: 'not-a-netpay-key' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('rejects a live secret passed as the public key', async () => {
      const res = await call(
        'POST',
        '/t/payments/config',
        ownerToken,
        { ...VALID_CONFIG, publicKey: 'sk_netpay_e2enotarealkey' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('rejects an unknown environment', async () => {
      const res = await call(
        'POST',
        '/t/payments/config',
        ownerToken,
        { ...VALID_CONFIG, environment: 'STAGING' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('stores credentials and never returns the provider secret', async () => {
      const res = await call('POST', '/t/payments/config', ownerToken, VALID_CONFIG, tenantHeader());
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('sk_netpay');
      expect(res.body['publicKey']).toBe(VALID_CONFIG.publicKey);
      expect(res.body['environment']).toBe('SANDBOX');
      webhookToken = String(res.body['webhookToken']);
      expect(webhookToken.length).toBeGreaterThanOrEqual(24);
      expect(res.body['webhookUrlPath']).toBe(`/api/v1/payments/webhook/${webhookToken}`);
    });

    it('stores the secret encrypted rather than in the clear', async () => {
      const rows = await tenantRows<{ secretKeyCiphertext: string }>(
        `SELECT "secretKeyCiphertext" FROM "${tenantASchema}".payment_provider_config`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].secretKeyCiphertext).not.toContain('sk_netpay');
      expect(rows[0].secretKeyCiphertext).not.toContain(VALID_CONFIG.secretKey);
    });

    it('keeps only a hash of the webhook token', async () => {
      const rows = await adminPool.query<{ tokenHash: string }>(
        'SELECT "tokenHash" FROM "payment_webhook_registry" WHERE "tenantId" = $1 AND "revokedAt" IS NULL',
        [tenantAId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].tokenHash).toHaveLength(64);
      expect(rows.rows[0].tokenHash).not.toBe(webhookToken);
    });

    it('does not hand out a second webhook token when configuration is repeated', async () => {
      const again = await call('POST', '/t/payments/config', ownerToken, VALID_CONFIG, tenantHeader());
      expect(again.status).toBe(200);
      expect(again.body['webhookToken']).toBeNull();
      expect(again.body['webhookUrlPath']).toBeNull();
    });

    it('lets an ADMIN configure payments', async () => {
      const res = await call('POST', '/t/payments/config', tenantAdminToken, VALID_CONFIG, tenantHeader());
      expect(res.status).toBe(200);
    });

    it('rotates the webhook token and revokes the old one', async () => {
      const rotated = await call(
        'POST',
        '/t/payments/config/webhook-token',
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(rotated.status).toBe(200);
      expect(JSON.stringify(rotated.body)).not.toContain(webhookToken);
      const fresh = Object.values(rotated.body).find(
        (v) => typeof v === 'string' && v.length >= 24 && !v.startsWith('/'),
      );
      expect(typeof fresh).toBe('string');
      const active = await adminPool.query(
        'SELECT 1 FROM "payment_webhook_registry" WHERE "tenantId" = $1 AND "revokedAt" IS NULL',
        [tenantAId],
      );
      expect(active.rows).toHaveLength(1);
      webhookToken = String(fresh);
    });

    it('refuses a VIEWER and an AUDITOR from rotating the webhook token', async () => {
      for (const token of [viewerAccessToken, auditorAccessToken]) {
        const res = await call('POST', '/t/payments/config/webhook-token', token, undefined, tenantHeader());
        expect(res.status).toBe(403);
      }
    });

    it('refuses to register a non-HTTPS webhook URL with the provider', async () => {
      const res = await call(
        'POST',
        '/t/payments/config/webhook-register',
        ownerToken,
        { url: 'http://shop.example.com/hook' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('inbound notifications', () => {
    it('answers 202 for an unrecognised token and stores nothing', async () => {
      const before = await tenantRows<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${tenantASchema}".payment_webhook_events`,
      );
      const res = await call('POST', '/payments/webhook/token-inventado', undefined, {
        event: 'sessionLink.paid',
        data: { transactionId: 'nope' },
      });
      expect(res.status).toBe(202);
      const after = await tenantRows<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${tenantASchema}".payment_webhook_events`,
      );
      expect(after[0].n).toBe(before[0].n);
    });

    it('answers the same way for a known and an unknown token', async () => {
      const known = await call('POST', `/payments/webhook/${webhookToken}`, undefined, { event: 'ping' });
      const unknown = await call('POST', '/payments/webhook/zzzzzzzzzzzzzzzzzzzzzzzzzzzz', undefined, {
        event: 'ping',
      });
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.body).toEqual(unknown.body);
    });

    it('ignores X-Tenant-Id: the token alone names the tenant', async () => {
      const res = await call(
        'POST',
        '/payments/webhook/token-inventado',
        undefined,
        { event: 'x', data: { transactionId: 't1' } },
        { 'x-tenant-id': tenantAId },
      );
      expect(res.status).toBe(202);
      const rows = await tenantRows<{ netpayTransactionId: string }>(
        `SELECT "netpayTransactionId" FROM "${tenantASchema}".payment_webhook_events WHERE "netpayTransactionId" = 't1'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('records a notification for a real token without trusting it', async () => {
      const reference = `E2E-FORGED-${RUN_ID}`;
      const orderId = await seedOrder(reference);

      const res = await call('POST', `/payments/webhook/${webhookToken}`, undefined, {
        event: 'sessionLink.paid',
        data: { transactionId: 'txn_never_seen_by_netpay', reference, status: 'PAID', amount: '650.00' },
      });
      expect(res.status).toBe(202);

      // The handler answers before verification finishes in some deployments.
      const deadline = Date.now() + 15_000;
      let outcome: string | null = null;
      while (Date.now() < deadline && outcome === null) {
        const events = await tenantRows<{ outcome: string | null }>(
          `SELECT outcome FROM "${tenantASchema}".payment_webhook_events WHERE "netpayTransactionId" = 'txn_never_seen_by_netpay'`,
        );
        outcome = events[0]?.outcome ?? null;
        if (outcome === null) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      expect(outcome).not.toBeNull();

      const order = await tenantRows<{ status: string; verifiedAmount: string | null }>(
        `SELECT status, "verifiedAmount" FROM "${tenantASchema}".payment_orders WHERE id = $1`,
        [orderId],
      );
      expect(order[0].status).not.toBe('PAID');
      expect(order[0].verifiedAmount).toBeNull();
    });

    it('keeps no card data from a notification', async () => {
      await call('POST', `/payments/webhook/${webhookToken}`, undefined, {
        event: 'sessionLink.paid',
        data: { transactionId: 'txn_pan', cardNumber: '4111111111111111', cvv: '123' },
      });
      const rows = await tenantRows<{ payloadSanitized: unknown }>(
        `SELECT "payloadSanitized" FROM "${tenantASchema}".payment_webhook_events WHERE "netpayTransactionId" = 'txn_pan'`,
      );
      expect(JSON.stringify(rows)).not.toContain('4111111111111111');
      expect(JSON.stringify(rows)).not.toContain('cvv');
    });

    it('treats a notification without a transaction as ignorable', async () => {
      const res = await call('POST', `/payments/webhook/${webhookToken}`, undefined, { event: 'ping' });
      expect(res.status).toBe(202);
    });

    it('refuses the retired webhook token after rotation', async () => {
      const retired = 'retired-token-does-not-exist-anywhere';
      const res = await call('POST', `/payments/webhook/${retired}`, undefined, { event: 'ping' });
      expect(res.status).toBe(202);
    });
  });

  describe('outbound destinations', () => {
    /** Reads `error.code` and `error.details.reason` from the error envelope (BN-REQ-API-002). */
    const blockedReason = (body: Record<string, unknown>) => {
      const error = body['error'] as { code?: unknown; details?: { reason?: unknown } } | undefined;
      return { code: error?.code, reason: error?.details?.reason };
    };

    it('refuses a loopback destination before contacting it', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        { url: 'https://127.0.0.1/steal', events: ['payment.paid'] },
        tenantHeader(),
      );
      // A well-formed URL pointing somewhere off limits: 422 BLOCKED_ADDRESS
      // (BN-REQ-EVT-001), not a 400 validation error.
      expect(res.status).toBe(422);
      expect(blockedReason(res.body)).toEqual({ code: 'BLOCKED_ADDRESS', reason: 'PRIVATE_ADDRESS' });
    });

    it('refuses the cloud metadata address', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        { url: 'https://169.254.169.254/latest/meta-data/', events: ['payment.paid'] },
        tenantHeader(),
      );
      // A well-formed URL pointing somewhere off limits: 422 BLOCKED_ADDRESS
      // (BN-REQ-EVT-001), not a 400 validation error.
      expect(res.status).toBe(422);
      expect(blockedReason(res.body)).toEqual({ code: 'BLOCKED_ADDRESS', reason: 'METADATA_ADDRESS' });
    });

    it('refuses a private RFC1918 destination', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        { url: 'https://10.0.0.5/hook', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(res.status).toBe(422);
      expect(blockedReason(res.body)).toEqual({ code: 'BLOCKED_ADDRESS', reason: 'PRIVATE_ADDRESS' });
    });

    it('refuses plain HTTP while HTTPS is required', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        { url: 'http://hooks.example.com/payments', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('refuses an event nobody emits', async () => {
      const res = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        { url: 'https://hooks.example.com/payments', events: ['payment.exploded'] },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('lists the events that can be subscribed to', async () => {
      const res = await call('GET', '/t/webhooks/events', ownerToken, undefined, tenantHeader());
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('payment.paid');
    });

    let endpointId = '';
    let firstSecret = '';

    it('shows a signing secret once and never again', async () => {
      const created = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        // A public IP literal: the URL guard refuses names that do not resolve or that
        // resolve to several addresses, and the suite must not depend on DNS.
        { url: 'https://8.8.8.8/payments', events: ['payment.paid'], description: 'e2e' },
        tenantHeader(),
      );
      if (created.status !== 201) {
        throw new Error(`create endpoint answered ${created.status}: ${JSON.stringify(created.body)}`);
      }
      firstSecret = String(created.body['secret']);
      expect(firstSecret).toMatch(/^whsec_/);
      endpointId = String(
        (created.body['endpoint'] as Record<string, unknown> | undefined)?.['id'] ?? created.body['id'],
      );

      const listed = await call('GET', '/t/webhooks', ownerToken, undefined, tenantHeader());
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(firstSecret);
      expect(JSON.stringify(listed.body)).toContain(endpointId);
    });

    it('rotates the secret and shows the new one once', async () => {
      const res = await call(
        'POST',
        `/t/webhooks/${endpointId}/rotate-secret`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      const next = String(res.body['secret']);
      expect(next).toMatch(/^whsec_/);
      expect(next).not.toBe(firstSecret);
      const end = await call(
        'POST',
        `/t/webhooks/${endpointId}/end-rotation`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(end.status).toBe(204);
    });

    it('disables and re-enables an endpoint', async () => {
      const off = await call(
        'POST',
        `/t/webhooks/${endpointId}/status`,
        ownerToken,
        { enabled: false },
        tenantHeader(),
      );
      expect(off.status).toBe(204);
      const on = await call(
        'POST',
        `/t/webhooks/${endpointId}/status`,
        ownerToken,
        { enabled: true },
        tenantHeader(),
      );
      expect(on.status).toBe(204);
    });

    it('answers 404 for an endpoint that does not exist', async () => {
      const res = await call(
        'POST',
        '/t/webhooks/00000000-0000-4000-8000-000000000000/rotate-secret',
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(404);
    });

    it('refuses an AUDITOR from rotating a secret', async () => {
      const res = await call(
        'POST',
        `/t/webhooks/${endpointId}/rotate-secret`,
        auditorAccessToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(403);
    });
  });

  describe('members created through the API', () => {
    const signInAs = async (email: string, password: string): Promise<string> => {
      const res = await call(
        'POST',
        '/t/auth/sign-in',
        undefined,
        { email, password },
        { 'x-tenant-slug': SLUG },
      );
      expect(res.status).toBe(200);
      return res.body['accessToken'] as string;
    };

    it('grants the matching role, so an ADMIN can configure payments but not webhooks', async () => {
      const email = `api-admin-${RUN_ID}@acme.test`;
      const created = await call(
        'POST',
        '/t/users',
        ownerToken,
        { email, displayName: 'API Admin', password: 'Api-Admin-Secret!1', role: 'ADMIN' },
        tenantHeader(),
      );
      expect(created.status).toBe(201);
      const token = await signInAs(email, 'Api-Admin-Secret!1');
      const configure = await call('POST', '/t/payments/config', token, VALID_CONFIG, tenantHeader());
      expect(configure.status).toBe(200);
      const hook = await call(
        'POST',
        '/t/webhooks',
        token,
        { url: 'https://8.8.8.8/payments', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(hook.status).toBe(403);
    });

    it('grants a VIEWER read-only authority', async () => {
      const email = `api-viewer-${RUN_ID}@acme.test`;
      const created = await call(
        'POST',
        '/t/users',
        ownerToken,
        { email, displayName: 'API Viewer', password: 'Api-Viewer-Secret!1', role: 'VIEWER' },
        tenantHeader(),
      );
      expect(created.status).toBe(201);
      const token = await signInAs(email, 'Api-Viewer-Secret!1');
      const orders = await call('GET', '/t/payments/orders', token, undefined, tenantHeader());
      expect(orders.status).toBe(403);
      const write = await call('POST', '/t/payments/config', token, VALID_CONFIG, tenantHeader());
      expect(write.status).toBe(403);
    });

    it('records the assignment in the tenant schema', async () => {
      const rows = await tenantRows<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${tenantASchema}".user_roles ur
         JOIN "${tenantASchema}".users u ON u.id = ur."userId" WHERE u."displayName" LIKE 'API %'`,
      );
      expect(rows[0].n).toBe('2');
    });
  });

  describe('installments', () => {
    it('lists the installment plans it supports', async () => {
      const res = await call('GET', '/t/payments/installments', ownerToken, undefined, tenantHeader());
      expect(res.status).toBe(200);
      const plans = res.body['plans'] as { count: number; minimumAmount: number }[];
      expect(plans.map((p) => p.count)).toEqual([3, 6, 9, 12, 18]);
      expect(res.body['currency']).toBe('MXN');
      expect(JSON.stringify(res.body)).toContain('300');
    });
  });

  describe('order validation and state machine', () => {
    it('rejects an installment plan the provider does not offer', async () => {
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-MSI', amount: '5000.00', installments: 5 },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('rejects an amount below the minimum for the plan', async () => {
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-MSI-LOW', amount: '10.00', installments: 12 },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it.each([['-5.00'], ['abc'], ['10.999'], ['']])('rejects the amount %p', async (amount) => {
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-BAD', amount },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('rejects a lower-case currency and an unknown checkout mode', async () => {
      const cur = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-CUR', amount: '10.00', currency: 'mxn' },
        tenantHeader(),
      );
      expect(cur.status).toBe(400);
      const mode = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-MODE', amount: '10.00', checkoutMode: 'iframe' },
        tenantHeader(),
      );
      expect(mode.status).toBe(400);
    });

    it('rejects unknown properties rather than passing them on', async () => {
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-EXTRA', amount: '10.00', status: 'PAID' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('lists orders and reads one', async () => {
      const id = await seedOrder(`E2E-LIST-${RUN_ID}`);
      const list = await call('GET', '/t/payments/orders', ownerToken, undefined, tenantHeader());
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(id);
      const one = await call('GET', `/t/payments/orders/${id}`, ownerToken, undefined, tenantHeader());
      expect(one.status).toBe(200);
      expect(JSON.stringify(one.body)).toContain(id);
    });

    it('lists orders with a page size given in the query string', async () => {
      await seedOrder(`E2E-PAGE-${RUN_ID}`);
      const ok = await call('GET', '/t/payments/orders?limit=2', ownerToken, undefined, tenantHeader());
      expect(ok.status).toBe(200);
      const items = Array.isArray(ok.body) ? ok.body : ((ok.body['items'] ?? ok.body['orders']) as unknown[]);
      expect(items.length).toBeLessThanOrEqual(2);
      expect(items.length).toBeGreaterThan(0);
      for (const bad of ['0', '101', 'abc', '1.5']) {
        const res = await call(
          'GET',
          `/t/payments/orders?limit=${bad}`,
          ownerToken,
          undefined,
          tenantHeader(),
        );
        expect(res.status).toBe(400);
      }
    });

    it('answers 404 for an order that does not exist', async () => {
      const res = await call(
        'GET',
        '/t/payments/orders/00000000-0000-4000-8000-000000000000',
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(404);
    });

    it('refuses a refund of an order that never settled', async () => {
      const id = await seedOrder(`E2E-REFUND-${RUN_ID}`);
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect([404, 409]).toContain(res.status);
      const row = await tenantRows<{ status: string }>(
        `SELECT status FROM "${tenantASchema}".payment_orders WHERE id = $1`,
        [id],
      );
      expect(row[0].status).toBe('PENDING');
    });

    it('refuses a refund for an order that does not exist', async () => {
      const res = await call(
        'POST',
        '/t/payments/orders/00000000-0000-4000-8000-000000000000/refund',
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(404);
    });

    it('refuses a card number where a token belongs', async () => {
      const id = await seedOrder(`E2E-PAN-${RUN_ID}`);
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: '4111111111111111', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('not card data');
    });

    it('refuses a charge with no billing data', async () => {
      const id = await seedOrder(`E2E-BILL-${RUN_ID}`);
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('refuses a VIEWER from charging', async () => {
      const id = await seedOrder(`E2E-VCHARGE-${RUN_ID}`);
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        viewerAccessToken,
        {
          cardToken: 'token_abcdefghijklmnop',
          billing: BILLING,
          ...DEVICE,
        },
        tenantHeader(),
      );
      expect(res.status).toBe(403);
    });
  });

  describe('stored cards', () => {
    const profile = {
      identifier: 'buyer-1',
      firstName: 'Ana',
      lastName: 'Lopez',
      email: 'ana@example.mx',
      phone: '5512345678',
    };

    it('refuses a card number where a token belongs', async () => {
      const res = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        { ...profile, cardToken: '4111111111111111' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('4111111111111111');
    });

    it('rejects an invalid e-mail', async () => {
      const res = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        { ...profile, email: 'nope' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
    });

    it('refuses a VIEWER and an AUDITOR from storing a card', async () => {
      for (const token of [viewerAccessToken, auditorAccessToken]) {
        const res = await call('POST', '/t/payments/cards', token, profile, tenantHeader());
        expect(res.status).toBe(403);
      }
    });
  });

  /**
   * Waits for an order to reach one of `wanted`, or gives up.
   *
   * Settlement runs after the notification is acknowledged, so the row is not
   * final by the time the request returns.
   *
   * @param schema Tenant schema holding the order.
   * @param id Order id.
   * @param wanted Statuses that end the wait.
   * @param timeoutMs How long to keep looking.
   * @returns The status reached.
   */
  async function waitForOrderStatus(
    schema: string,
    id: string,
    wanted: string[],
    timeoutMs = 10_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const unit = await tenantPool.connect();
      let status = '';
      try {
        await unit.query('BEGIN');
        await unit.query(`SET LOCAL app.current_tenant = '${schema}'`);
        const res = await unit.query<{ status: string }>(
          `SELECT status FROM "${schema}".payment_orders WHERE id = $1`,
          [id],
        );
        await unit.query('COMMIT');
        status = res.rows[0]?.status ?? '';
      } catch (error) {
        await unit.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        unit.release();
      }
      if (wanted.includes(status)) {
        return status;
      }
      if (Date.now() > deadline) {
        return status;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  describe('tenant isolation', () => {
    /**
     * Every test here is written from the same position: a member of another
     * tenant, holding that tenant's own token. A platform administrator is
     * deliberately not used, because addressing any tenant is what one is for.
     */
    let rival: RivalTenant;
    /** An order belonging to tenant A, the thing the rival must not reach. */
    let orderAId = '';
    let orderAReference = '';
    /** The rival's inbound webhook token: valid, but scoped to the rival. */
    let rivalWebhookToken = '';

    beforeAll(async () => {
      rival = await createRivalTenant(`pay-rival-${RUN_ID}`);
      // Both tenants need their own stored credentials: every payment route reads
      // the caller's configuration, and a tenant with none is refused before it
      // gets as far as touching another tenant's data. Tenant A's is written here
      // rather than borrowed from another describe, so this block stands alone.
      expect(
        (await call('POST', '/t/payments/config', ownerToken, VALID_CONFIG, tenantHeader())).status,
      ).toBe(200);
      expect(
        (await call('POST', '/t/payments/config', rival.token, VALID_CONFIG, rivalHeader())).status,
      ).toBe(200);
      const created = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: `E2E-ISO-${RUN_ID}`, amount: '650.00', checkoutMode: 'custom' },
        tenantHeader(),
      );
      expect(created.status).toBe(201);
      orderAId = created.body['id'] as string;
      orderAReference = created.body['orderReference'] as string;
      const token = await call(
        'POST',
        '/t/payments/config/webhook-token',
        rival.token,
        undefined,
        rivalHeader(),
      );
      expect(token.status).toBe(200);
      rivalWebhookToken = token.body['token'] as string;
    }, 120_000);

    afterAll(async () => {
      if (rival !== undefined) {
        await destroyRivalTenant(rival.id, rival.schema);
      }
    });

    const rivalHeader = (): Record<string, string> => ({ 'x-tenant-id': rival.id });

    it('refuses to read an order belonging to another tenant', async () => {
      const res = await call('GET', `/t/payments/orders/${orderAId}`, rival.token, undefined, rivalHeader());
      // 404 rather than 403: confirming the order exists would itself leak, and
      // the row is not in the rival's schema, so there is honestly nothing to find.
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(`E2E-ISO-${RUN_ID}`);
    });

    it('refuses to charge, confirm and refund an order belonging to another tenant', async () => {
      for (const [method, path, body] of [
        [
          'POST',
          `/t/payments/orders/${orderAId}/charge`,
          { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        ],
        ['POST', `/t/payments/orders/${orderAId}/confirm`, { processorTransactionId: 'proc-1' }],
        ['POST', `/t/payments/orders/${orderAId}/refund`, undefined],
      ] as const) {
        const res = await call(method, path, rival.token, body, rivalHeader());
        expect(res.status).toBe(404);
      }
      // Nothing reached the provider, and the order is untouched.
      const rows = await tenantRows<{ status: string; netpayTransactionId: string | null }>(
        `SELECT status, "netpayTransactionId" FROM "${tenantASchema}".payment_orders WHERE id = $1`,
        [orderAId],
      );
      expect(rows[0]?.status).toBe('PENDING');
      expect(rows[0]?.netpayTransactionId).toBeNull();
    });

    it('lists only the caller’s own orders', async () => {
      const res = await call('GET', '/t/payments/orders?limit=100', rival.token, undefined, rivalHeader());
      expect(res.status).toBe(200);
      const listed = Array.isArray(res.body) ? res.body : (res.body['items'] ?? []);
      expect(JSON.stringify(listed)).not.toContain(`E2E-ISO-${RUN_ID}`);
      expect(JSON.stringify(listed)).not.toContain(orderAId);
    });

    it('will not settle another tenant’s order with its own webhook token', async () => {
      // The rival token is a valid token, for the rival tenant. It names tenant A's
      // order reference explicitly, which is what a stolen or guessed token would
      // look like. The token must resolve to its own schema and find nothing.
      // The provider would happily confirm this transaction, so the only thing
      // standing between the caller and a settled order is the schema boundary.
      const stolen = `txn_stolen_${RUN_ID}`;
      provider.transactions.set(stolen, { status: 'DONE', amount: 650 });
      const forged = await call('POST', `/payments/webhook/${rivalWebhookToken}`, undefined, {
        event: 'sessionLink.paid',
        data: { transactionId: stolen, reference: orderAReference, status: 'PAID' },
      });
      // A notification is always acknowledged: refusing loudly would tell the
      // holder of a guessed token that the reference was real.
      expect(forged.status).toBe(202);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await waitForOrderStatus(tenantASchema, orderAId, ['PAID'], 1_500)).toBe('PENDING');
      const rows = await tenantRows<{ netpayTransactionId: string | null }>(
        `SELECT "netpayTransactionId" FROM "${tenantASchema}".payment_orders WHERE id = $1`,
        [orderAId],
      );
      expect(rows[0]?.netpayTransactionId).toBeNull();
    });

    it('rotating one tenant’s webhook token leaves the other tenant’s working', async () => {
      // Rotation revokes every earlier token for the tenant. Scoping that by tenant
      // is the whole question: a missing tenantId would silently disable every other
      // tenant's notifications, and no single-tenant test would ever see it.
      const mine = await call(
        'POST',
        '/t/payments/config/webhook-token',
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(mine.status).toBe(200);
      const myToken = mine.body['token'] as string;

      // A rival order, so the rival's own token has something it is allowed to settle.
      const rivalOrder = await call(
        'POST',
        '/t/payments/orders',
        rival.token,
        { merchantReferenceCode: `E2E-ISO-RIVAL-${RUN_ID}`, amount: '650.00', checkoutMode: 'custom' },
        rivalHeader(),
      );
      expect(rivalOrder.status).toBe(201);
      const rivalOrderId = rivalOrder.body['id'] as string;
      const rivalReference = rivalOrder.body['orderReference'] as string;

      // The rival rotates. Its own first token dies with it; tenant A's must not.
      const rotated = await call(
        'POST',
        '/t/payments/config/webhook-token',
        rival.token,
        undefined,
        rivalHeader(),
      );
      expect(rotated.status).toBe(200);
      const rivalToken2 = rotated.body['token'] as string;

      // The retired token is acknowledged exactly like an unknown one, so the test
      // has to look at what it did rather than at the status code: the rival's order
      // stays pending, even though the provider would confirm that transaction.
      const staleTx = `txn_stale_${RUN_ID}`;
      provider.transactions.set(staleTx, { status: 'DONE', amount: 650 });
      expect(
        (
          await call('POST', `/payments/webhook/${rivalWebhookToken}`, undefined, {
            event: 'sessionLink.paid',
            data: { transactionId: staleTx, reference: rivalReference, status: 'PAID' },
          })
        ).status,
      ).toBe(202);
      await new Promise((r) => setTimeout(r, 1_000));
      const rivalSchemaRows = await waitForOrderStatus(rival.schema, rivalOrderId, ['PAID'], 1_500);
      expect(rivalSchemaRows).toBe('PENDING');

      // The new token works for its own tenant.
      const freshTx = `txn_fresh_${RUN_ID}`;
      provider.transactions.set(freshTx, { status: 'DONE', amount: 650 });
      await call('POST', `/payments/webhook/${rivalToken2}`, undefined, {
        event: 'sessionLink.paid',
        data: { transactionId: freshTx, reference: rivalReference, status: 'PAID' },
      });
      expect(await waitForOrderStatus(rival.schema, rivalOrderId, ['PAID'])).toBe('PAID');

      // And tenant A's token, rotated before all of this, still settles A's order.
      const txA = `txn_after_${RUN_ID}`;
      provider.transactions.set(txA, { status: 'DONE', amount: 650 });
      await call('POST', `/payments/webhook/${myToken}`, undefined, {
        event: 'sessionLink.paid',
        data: { transactionId: txA, reference: orderAReference, status: 'PAID' },
      });
      expect(await waitForOrderStatus(tenantASchema, orderAId, ['PAID'])).toBe('PAID');
      const rows = await tenantRows<{ netpayTransactionId: string | null }>(
        `SELECT "netpayTransactionId" FROM "${tenantASchema}".payment_orders WHERE id = $1`,
        [orderAId],
      );
      expect(rows[0]?.netpayTransactionId).toBe(txA);
    });

    it('refuses to store a card against another tenant’s configuration', async () => {
      // Storing a card writes to the caller’s own tenant schema, so the rival’s
      // call must land in the rival’s data and never read the first tenant’s.
      const stored = await call(
        'POST',
        '/t/payments/cards',
        rival.token,
        {
          identifier: `rival-${RUN_ID}`,
          firstName: 'R',
          lastName: 'R',
          email: 'r@rival.test',
          phone: '5510000000',
        },
        rivalHeader(),
      );
      expect(stored.status).toBe(201);
      const mine = await tenantRows<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${tenantASchema}".payment_customers WHERE "netpayCustomerId" = $1`,
        [stored.body['netpayCustomerId']],
      );
      expect(mine[0]?.n).toBe(0);
    });

    it('refuses to read or rotate another tenant’s webhook destination', async () => {
      const registered = await call(
        'POST',
        '/t/webhooks',
        ownerToken,
        { url: 'https://8.8.8.8/hook', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(registered.status).toBe(201);
      const id = registered.body['id'] as string;
      try {
        const listed = await call('GET', '/t/webhooks', rival.token, undefined, rivalHeader());
        expect(JSON.stringify(listed.body)).not.toContain(id);
        // Rotating a destination you cannot see must not touch it either.
        await call('POST', `/t/webhooks/${id}/rotate-secret`, rival.token, undefined, rivalHeader());
        const stillThere = await call('GET', '/t/webhooks', ownerToken, undefined, tenantHeader());
        expect(JSON.stringify(stillThere.body)).toContain(id);
      } finally {
        await call('DELETE', `/t/webhooks/${id}`, ownerToken, undefined, tenantHeader());
      }
    });

    it('lets two tenants use the same merchant code without colliding', async () => {
      const code = `E2E-SHARED-${RUN_ID}`;
      const mine = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: code, amount: '650.00', checkoutMode: 'custom' },
        tenantHeader(),
      );
      const theirs = await call(
        'POST',
        '/t/payments/orders',
        rival.token,
        { merchantReferenceCode: code, amount: '100.00', checkoutMode: 'custom' },
        rivalHeader(),
      );
      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      // Same code, different orders, different references: the unique index is
      // per schema, which is what makes the two tenants independent.
      expect(mine.body['orderReference']).not.toBe(theirs.body['orderReference']);
      expect(mine.body['id']).not.toBe(theirs.body['id']);
    });

    it('still lets a platform administrator address either tenant', async () => {
      // The counterpart to every test above: isolation must not become isolation
      // from the operator who runs the platform.
      const mine = await call(
        'GET',
        '/t/payments/orders?limit=100',
        adminAccessToken,
        undefined,
        tenantHeader(),
      );
      const theirs = await call(
        'GET',
        '/t/payments/orders?limit=100',
        adminAccessToken,
        undefined,
        rivalHeader(),
      );
      expect(mine.status).toBe(200);
      expect(theirs.status).toBe(200);
      expect(JSON.stringify(mine.body)).toContain(`E2E-ISO-${RUN_ID}`);
      expect(JSON.stringify(theirs.body)).not.toContain(`E2E-ISO-${RUN_ID}`);
    });
  });

  describe('provider flow against a stand-in Netpay', () => {
    beforeAll(async () => {
      // This block takes a token of its own. Rotation revokes every earlier token
      // for the tenant, so a token captured by an earlier describe would stop
      // working the moment any other block rotates, and every assertion here
      // would silently be testing an endpoint that no longer routes anywhere.
      const res = await call(
        'POST',
        '/t/payments/config/webhook-token',
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      webhookToken = String(res.body['token']);
      expect(webhookToken.length).toBeGreaterThanOrEqual(24);
    });

    interface OrderRow extends Record<string, unknown> {
      id: string;
      orderReference: string;
      status: string;
      sequence: number;
      amountToken: string | null;
      netpayTransactionId: string | null;
      verifiedAmount: string | null;
      failureReason: string | null;
      checkoutSessionId: string | null;
    }

    const orderRow = async (id: string): Promise<OrderRow> => {
      const rows = await tenantRows<OrderRow>(
        `SELECT id, "orderReference", status, sequence, "amountToken", "netpayTransactionId", "verifiedAmount"::text, "failureReason", "checkoutSessionId"
         FROM "${tenantASchema}".payment_orders WHERE id = $1`,
        [id],
      );
      return rows[0];
    };

    /** Waits until an order reaches one of the statuses, since notifications are handled after the 202. */
    const waitForStatus = async (id: string, statuses: string[]): Promise<OrderRow> => {
      const deadline = Date.now() + 15_000;
      let row = await orderRow(id);
      while (!statuses.includes(row.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        row = await orderRow(id);
      }
      return row;
    };

    const notify = (reference: string, transactionId: string, claimed = 'PAID') =>
      call('POST', `/payments/webhook/${webhookToken}`, undefined, {
        event: 'sessionLink.paid',
        data: { transactionId, reference, status: claimed },
      });

    /** Creates an order through the API and returns its id and reference. */
    const createOrder = async (code: string, amount = '650.00', extra: Record<string, unknown> = {}) => {
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: code, amount, ...extra },
        tenantHeader(),
      );
      expect(res.status).toBe(201);
      const id = res.body['id'] as string;
      return { id, res, row: await orderRow(id) };
    };

    beforeEach(() => {
      provider.calls.length = 0;
      provider.failNext = 0;
      provider.failChargeNext = 0;
      provider.delayPath = null;
      provider.delayMs = 0;
      provider.tokenAmountOverride = null;
      provider.chargeStatus = 'DONE';
      provider.threeDS = false;
    });

    it('creates an order whose amount is tokenised server-side (Checkout Plus)', async () => {
      const { res, row } = await createOrder(`E2E-TOKEN-${RUN_ID}`, '650.00', { checkoutMode: 'plus' });
      const checkout = res.body['checkout'] as Record<string, unknown>;
      expect(String(checkout['amountToken'])).toMatch(/^tokenAmount_/);
      expect(checkout['sandboxMode']).toBe(true);
      expect(row.amountToken).toBe(checkout['amountToken']);
      expect(row.status).toBe('PENDING');
      expect(JSON.stringify(res.body)).not.toContain('sk_netpay');

      const sent = provider.calls.find((c) => c.path === '/v3/token/amount');
      expect(sent?.body['amount']).toBe(650);
      // The tenant's own secret authenticates the call, and only as a header.
      expect(sent?.authorization).toBe(VALID_CONFIG.secretKey);
    });

    it('refuses an order when the provider binds a different amount', async () => {
      provider.tokenAmountOverride = 1;
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: `E2E-TAMPER-${RUN_ID}`, amount: '650.00', checkoutMode: 'plus' },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
      const rows = await tenantRows<OrderRow>(
        `SELECT status, "failureReason" FROM "${tenantASchema}".payment_orders WHERE "merchantReferenceCode" = $1`,
        [`E2E-TAMPER-${RUN_ID}`],
      );
      expect(rows[0].status).toBe('PENDING');
      expect(rows[0].failureReason).not.toBeNull();
    });

    it('answers 504 (outcome unknown) and keeps the order unpaid when the provider is down', async () => {
      provider.failNext = 500;
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: `E2E-DOWN-${RUN_ID}`, amount: '650.00' },
        tenantHeader(),
      );
      // A provider 5xx is not an answer (BN-REQ-PAY-011).
      expect(res.status).toBe(504);
      expect((res.body['error'] as { code: string; retryable: boolean }).code).toBe(
        'PROVIDER_OUTCOME_UNKNOWN',
      );
      expect(JSON.stringify(res.body)).not.toContain(VALID_CONFIG.secretKey);
      const rows = await tenantRows<OrderRow>(
        `SELECT status, "failureReason" FROM "${tenantASchema}".payment_orders WHERE "merchantReferenceCode" = $1`,
        [`E2E-DOWN-${RUN_ID}`],
      );
      expect(rows[0].status).toBe('PENDING');
      expect(rows[0].failureReason).toBe('Checkout session could not be created.');
    });

    it('rejects an installment plan that the amount does not reach', async () => {
      const res = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-MSI-OK', amount: '650.00', installments: 12 },
        tenantHeader(),
      );
      expect(res.status).toBe(400);
      expect(provider.calls).toHaveLength(0);
    });

    it('settles an order only after the provider confirms the transaction', async () => {
      const { id, row } = await createOrder(`E2E-PAID-${RUN_ID}`);
      const tx = `txn_paid_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });

      const res = await notify(row.orderReference, tx);
      expect(res.status).toBe(202);
      const paid = await waitForStatus(id, ['PAID']);
      expect(paid.status).toBe('PAID');
      expect(paid.verifiedAmount).toBe('650.00');
      expect(paid.netpayTransactionId).toBe(tx);

      // The notification only said "ask"; the provider was asked.
      const asked = provider.calls.filter((c) => c.method === 'GET' && c.path === `/v3/transactions/${tx}`);
      expect(asked.length).toBeGreaterThanOrEqual(1);

      // A redelivery of a settled order moves nothing.
      const before = (await orderRow(id)).sequence;
      await notify(row.orderReference, tx);
      await new Promise((r) => setTimeout(r, 1_000));
      expect((await orderRow(id)).sequence).toBe(before);
    });

    it('does not settle on a notification that claims PAID while the provider says declined', async () => {
      const { id, row } = await createOrder(`E2E-DECL-${RUN_ID}`);
      const tx = `txn_declined_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'REJECT', amount: 650 });
      await notify(row.orderReference, tx, 'PAID');
      const after = await waitForStatus(id, ['FAILED']);
      expect(after.status).toBe('FAILED');
      expect(after.verifiedAmount).toBeNull();
    });

    it('never settles when the provider reports a different amount', async () => {
      const { id, row } = await createOrder(`E2E-MISMATCH-${RUN_ID}`);
      const tx = `txn_mismatch_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 1 });
      await notify(row.orderReference, tx);
      const after = await waitForStatus(id, ['AMOUNT_MISMATCH']);
      expect(after.status).toBe('AMOUNT_MISMATCH');
      expect(after.verifiedAmount).toBe('1.00');
    });

    it('keeps an in-process transaction pending verification', async () => {
      const { id, row } = await createOrder(`E2E-INPROC-${RUN_ID}`);
      const tx = `txn_inproc_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'IN_PROCESS', amount: 650 });
      await notify(row.orderReference, tx);
      const after = await waitForStatus(id, ['PENDING_VERIFICATION']);
      expect(after.status).toBe('PENDING_VERIFICATION');
    });

    it('leaves the order unconfirmed when the provider cannot be asked', async () => {
      const { id, row } = await createOrder(`E2E-ASKFAIL-${RUN_ID}`);
      provider.failNext = 500;
      await notify(row.orderReference, `txn_unknown_${RUN_ID}`);
      await new Promise((r) => setTimeout(r, 1_500));
      const after = await orderRow(id);
      expect(after.status).not.toBe('PAID');
      const events = await tenantRows<{ outcome: string | null }>(
        `SELECT outcome FROM "${tenantASchema}".payment_webhook_events WHERE "netpayTransactionId" = $1`,
        [`txn_unknown_${RUN_ID}`],
      );
      expect(events[0]?.outcome).toBe('VERIFICATION_FAILED');
    });

    it('does not let a forged notification pin an order to a transaction the provider never saw', async () => {
      const { id, row } = await createOrder(`E2E-POISON-${RUN_ID}`);
      await notify(row.orderReference, `txn_ghost_${RUN_ID}`);
      await new Promise((r) => setTimeout(r, 1_500));
      const poisoned = await orderRow(id);
      expect(poisoned.netpayTransactionId).toBeNull();
      expect(poisoned.status).toBe('PENDING');

      // The genuine notification still settles the order.
      const tx = `txn_real_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      const settled = await waitForStatus(id, ['PAID']);
      expect(settled.status).toBe('PAID');
      expect(settled.netpayTransactionId).toBe(tx);
    });

    it('refuses to bind an order to a second transaction', async () => {
      const { id, row } = await createOrder(`E2E-REBIND-${RUN_ID}`);
      const first = `txn_first_${RUN_ID}`;
      provider.transactions.set(first, { status: 'IN_PROCESS', amount: 650 });
      await notify(row.orderReference, first);
      await waitForStatus(id, ['PENDING_VERIFICATION']);
      const second = `txn_second_${RUN_ID}`;
      provider.transactions.set(second, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, second);
      await new Promise((r) => setTimeout(r, 1_500));
      const after = await orderRow(id);
      expect(after.status).not.toBe('PAID');
      expect(after.netpayTransactionId).toBe(first);
    });

    it('charges a token against a customer it creates, and settles from the provider at once', async () => {
      const { id, row } = await createOrder(`E2E-CHARGE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE, installments: 3 },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      const tx = String(res.body['transactionTokenId']);
      expect(res.body['status']).toBe('success');
      // The provider already knew the outcome, so the order settled without a notification.
      expect(res.body['orderStatus']).toBe('PAID');
      expect((await orderRow(id)).status).toBe('PAID');
      expect((await orderRow(id)).netpayTransactionId).toBe(tx);

      // The card was attached to a customer first, because Netpay refuses a token that has none.
      const created = provider.calls.find((c) => c.method === 'POST' && c.path === '/v4/clients');
      expect(created?.body['identifier']).toBe(row.orderReference);
      expect(created?.body['phone']).toBe(BILLING.phone);
      expect(created?.body['paymentSource']).toEqual({ type: 'card', source: 'token_abcdefghijklmnop' });

      const sent = provider.calls.find((c) => c.path === '/v3.5/charges/');
      expect(sent?.body['source']).toBe('token_abcdefghijklmnop');
      expect(sent?.body['amount']).toBe(650);
      expect(sent?.body['referenceID']).toBe(row.orderReference);
      expect(sent?.body['saveCard']).toBe('false');
      expect((sent?.body['client'] as { id: string }).id).toMatch(/^cus_/);
      expect((sent?.body['billing'] as Record<string, unknown>)['address']).toEqual(BILLING.address);
      // The unique order reference travels as the billing reference.
      expect((sent?.body['billing'] as Record<string, unknown>)['merchantReferenceCode']).toBe(
        row.orderReference,
      );
      expect((sent?.body['installments'] as { plan: { count: number } }).plan.count).toBe(3);
      // Nothing that looks like card data crossed the wire.
      expect(JSON.stringify(sent?.body)).not.toMatch(/card.?number|cvv|cvc|\bpan\b/i);

      const again = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(again.status).toBe(409);
    });

    it('does not return what Netpay echoes back from a charge', async () => {
      const { id } = await createOrder(`E2E-ECHO-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'amount',
        'currency',
        'orderStatus',
        'status',
        'transactionTokenId',
      ]);
    });

    it('keeps the order pending while the provider has not decided', async () => {
      provider.chargeStatus = 'REVIEW';
      const { id, row } = await createOrder(`E2E-CHARGE-PENDING-${RUN_ID}`, '650.00', {
        checkoutMode: 'custom',
      });
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(res.body['orderStatus']).toBe('PENDING_VERIFICATION');
      const tx = String(res.body['transactionTokenId']);
      // A repeat is refused while the first is unresolved: it would bill twice.
      const again = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(again.status).toBe(409);
      // The notification settles it once the provider says DONE.
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      expect((await waitForStatus(id, ['PAID'])).status).toBe('PAID');
    });

    it('refuses a charge without an address or a phone, which Netpay needs', async () => {
      const { id } = await createOrder(`E2E-CHARGE-FIELDS-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      const noAddress = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: { ...BILLING, address: undefined }, ...DEVICE },
        tenantHeader(),
      );
      expect(noAddress.status).toBe(400);
      const noPhone = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: { ...BILLING, phone: undefined }, ...DEVICE },
        tenantHeader(),
      );
      expect(noPhone.status).toBe(400);
      expect(provider.calls).toHaveLength(0);
    });

    it('uses a customer the caller already holds instead of creating one', async () => {
      const customer = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        {
          identifier: `held-${RUN_ID}`,
          firstName: 'Ana',
          lastName: 'Lopez',
          email: 'ana@example.mx',
          phone: '5512345678',
          cardToken: 'token_storedcardtoken01',
        },
        tenantHeader(),
      );
      expect(customer.status).toBe(201);
      const { id } = await createOrder(`E2E-HELD-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.calls.length = 0;
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        {
          cardToken: 'token_storedcardtoken01',
          billing: BILLING,
          ...DEVICE,
          cvv: '123',
          clientId: String(customer.body['netpayCustomerId']),
        },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(provider.calls.some((c) => c.path === '/v4/clients')).toBe(false);
    });

    it('sends the cvv of a stored card and refuses a stored-card charge without it', async () => {
      const customer = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        {
          identifier: `cvv-${RUN_ID}`,
          firstName: 'Ana',
          lastName: 'Lopez',
          email: 'ana@example.mx',
          phone: '5512345678',
          cardToken: 'token_cvvcardtoken0001',
        },
        tenantHeader(),
      );
      const clientId = String(customer.body['netpayCustomerId']);
      const { id } = await createOrder(`E2E-CVV-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.calls.length = 0;
      const without = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_cvvcardtoken0001', billing: BILLING, ...DEVICE, clientId },
        tenantHeader(),
      );
      expect(without.status).toBe(400);
      expect(provider.calls).toHaveLength(0);
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_cvvcardtoken0001', billing: BILLING, ...DEVICE, clientId, cvv: '987' },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      const sent = provider.calls.find((c) => c.path === '/v3.5/charges/');
      expect(sent?.body['cvv']).toBe('987');
      expect(sent?.body['saveCard']).toBe('false');
      expect(JSON.stringify(res.body)).not.toContain('987');
    });

    it('refuses a charge without the browser data 3-D Secure 2.0 needs', async () => {
      const { id } = await createOrder(`E2E-NODEVICE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.calls.length = 0;
      for (const body of [
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING },
        {
          cardToken: 'token_abcdefghijklmnop',
          billing: BILLING,
          deviceFingerPrint: DEVICE.deviceFingerPrint,
        },
        {
          cardToken: 'token_abcdefghijklmnop',
          billing: BILLING,
          deviceFingerPrint: DEVICE.deviceFingerPrint,
          deviceInformation: { deviceChannel: 'Browser' },
        },
      ]) {
        const res = await call('POST', `/t/payments/orders/${id}/charge`, ownerToken, body, tenantHeader());
        expect(res.status).toBe(400);
      }
      expect(provider.calls).toHaveLength(0);
    });

    it('does not leave a card stored after a one-time payment, but keeps it when asked', async () => {
      const once = await createOrder(`E2E-ONCE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.calls.length = 0;
      await call(
        'POST',
        `/t/payments/orders/${once.id}/charge`,
        ownerToken,
        { cardToken: 'token_onetimecard0001', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      const removed = provider.calls.find((c) => c.method === 'DELETE');
      expect(removed?.path).toMatch(/^\/v3\/clients\/cus_[0-9a-f]+\/token\/token_onetimecard0001$/);

      const kept = await createOrder(`E2E-SAVE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.calls.length = 0;
      await call(
        'POST',
        `/t/payments/orders/${kept.id}/charge`,
        ownerToken,
        { cardToken: 'token_savedcard000001', billing: BILLING, ...DEVICE, saveCard: true },
        tenantHeader(),
      );
      expect(provider.calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('forwards the reference id and user agent the browser produced', async () => {
      const { id } = await createOrder(`E2E-UA-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.calls.length = 0;
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        {
          cardToken: 'token_abcdefghijklmnop',
          billing: BILLING,
          ...DEVICE,
          referenceId: 'ref_from_3ds_lib',
          userAgent: 'Mozilla/5.0 Buyer',
        },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      const sent = provider.calls.find((c) => c.path === '/v3.5/charges/');
      expect(sent?.body['referenceID']).toBe('ref_from_3ds_lib');
      expect(sent?.body['sessionId']).toBe(DEVICE.deviceFingerPrint);
      const bad = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE, userAgent: 'x\r\nEvil: 1' },
        tenantHeader(),
      );
      expect(bad.status).toBe(400);
    });

    describe('stored cards', () => {
      let clientId = '';
      beforeAll(async () => {
        const customer = await call(
          'POST',
          '/t/payments/cards',
          ownerToken,
          {
            identifier: `wallet-${RUN_ID}`,
            firstName: 'Ana',
            lastName: 'Lopez',
            email: 'ana@example.mx',
            phone: '5512345678',
            cardToken: 'token_wallet_card01',
          },
          tenantHeader(),
        );
        clientId = String(customer.body['netpayCustomerId']);
      });

      it('reads, attaches and deletes cards, up to three', async () => {
        const read = await call(
          'GET',
          `/t/payments/cards/${clientId}`,
          ownerToken,
          undefined,
          tenantHeader(),
        );
        expect(read.status).toBe(200);
        expect((read.body['cards'] as unknown[]).length).toBe(1);

        const second = await call(
          'PUT',
          `/t/payments/cards/${clientId}/token`,
          ownerToken,
          { cardToken: 'token_wallet_card02', cvv: '123' },
          tenantHeader(),
        );
        expect(second.status).toBe(200);
        // The provider echoes the holder and IP; neither is passed on.
        expect(JSON.stringify(second.body)).not.toMatch(/Ana|10\.0\.0\.9/);
        const third = await call(
          'PUT',
          `/t/payments/cards/${clientId}/token`,
          ownerToken,
          { cardToken: 'token_wallet_card03', cvv: '123' },
          tenantHeader(),
        );
        expect(third.status).toBe(200);
        const fourth = await call(
          'PUT',
          `/t/payments/cards/${clientId}/token`,
          ownerToken,
          { cardToken: 'token_wallet_card04', cvv: '123' },
          tenantHeader(),
        );
        expect(fourth.status).toBe(409);

        const del = await call(
          'DELETE',
          `/t/payments/cards/${clientId}/token/token_wallet_card02`,
          ownerToken,
          undefined,
          tenantHeader(),
        );
        expect(del.status).toBe(200);
        const after = await call(
          'GET',
          `/t/payments/cards/${clientId}`,
          ownerToken,
          undefined,
          tenantHeader(),
        );
        expect((after.body['cards'] as unknown[]).length).toBe(2);
      });

      it('refuses a customer id or token that could change the provider URL', async () => {
        provider.calls.length = 0;
        for (const [method, path] of [
          ['GET', '/t/payments/cards/bad.id'],
          ['GET', '/t/payments/cards/a%3Fx'],
          ['DELETE', `/t/payments/cards/${clientId}/token/not-a-token`],
        ]) {
          const res = await call(method, path, ownerToken, undefined, tenantHeader());
          expect(res.status).toBe(400);
        }
        expect(provider.calls).toHaveLength(0);
      });

      it('refuses card data and a missing cvv when attaching, and honours permissions', async () => {
        const pan = await call(
          'PUT',
          `/t/payments/cards/${clientId}/token`,
          ownerToken,
          { cardToken: '4111111111111111', cvv: '123' },
          tenantHeader(),
        );
        expect(pan.status).toBe(400);
        const noCvv = await call(
          'PUT',
          `/t/payments/cards/${clientId}/token`,
          ownerToken,
          { cardToken: 'token_wallet_card09' },
          tenantHeader(),
        );
        expect(noCvv.status).toBe(400);
        const viewer = await call(
          'DELETE',
          `/t/payments/cards/${clientId}/token/token_wallet_card01`,
          viewerAccessToken,
          undefined,
          tenantHeader(),
        );
        expect(viewer.status).toBe(403);
      });
    });

    it('records a declined charge as FAILED, with the reason, instead of a provider error', async () => {
      const { id } = await createOrder(`E2E-DECLINE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.declineNext = true;
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(res.body['status']).toBe('failed');
      expect(res.body['orderStatus']).toBe('FAILED');
      expect(res.body['declineReason']).toBe('Rejected by Decision Manager');
      const row = await orderRow(id);
      expect(row.status).toBe('FAILED');
      expect(row.netpayTransactionId).toBe(res.body['transactionTokenId']);
    });

    it('answers 504 when the provider fails a charge with a 5xx, leaving the order unpaid', async () => {
      const { id } = await createOrder(`E2E-CHARGEFAIL-${RUN_ID}`);
      provider.failNext = 500;
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(res.status).toBe(504);
      expect(JSON.stringify(res.body)).not.toContain(VALID_CONFIG.secretKey);
      expect((await orderRow(id)).status).not.toBe('PAID');
    });

    it('refunds a settled order once', async () => {
      const { id, row } = await createOrder(`E2E-REFUND-OK-${RUN_ID}`);
      const tx = `txn_refund_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      await waitForStatus(id, ['PAID']);

      provider.calls.length = 0;
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(res.body['status']).toBe('REFUNDED');
      const put = provider.calls.find(
        (c) => c.method === 'PUT' && c.path === `/v2/transactions/refundable_${tx}/refund`,
      );
      expect(put?.body['amount']).toBe('650.00');
      expect(put?.body['motive']).toBe('Refund');
      // The reports service authenticates with its own header, not Authorization.
      expect(put?.apiKey).toBe(VALID_CONFIG.secretKey);
      expect(put?.authorization).toBeUndefined();
      // The charge's id was first translated to the id the refund service expects.
      expect(provider.calls.some((c) => c.method === 'GET' && c.path === `/v3/get/${tx}/transactionId`)).toBe(
        true,
      );
      expect((await orderRow(id)).status).toBe('REFUNDED');

      const second = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(second.status).toBe(409);
    });

    it('audits every status change and writes each event to the outbox, partial refunds included (BN-TASK-030, BN-TASK-004, BN-TASK-019)', async () => {
      const { id, row } = await createOrder(`E2E-AUDIT-${RUN_ID}`);
      const tx = `txn_audit_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      await waitForStatus(id, ['PAID']);

      const partial = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        { amount: '100.00' },
        tenantHeader(),
      );
      expect(partial.status).toBe(200);
      expect(partial.body['status']).toBe('PARTIALLY_REFUNDED');
      const rest = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(rest.status).toBe(200);
      expect(rest.body['status']).toBe('REFUNDED');

      // Audit: actor, tenant, order and from → to for every change (BN-REQ-OPS-011).
      const audits = await adminPool.query<{
        actorType: string;
        actorId: string | null;
        tenantId: string;
        metadata: { from: string | null; to: string; event: string | null };
      }>(
        `SELECT "actorType", "actorId", "tenantId", "metadata" FROM "audit_logs"
         WHERE "action" = 'payment.status_changed' AND "resourceId" = $1 ORDER BY "createdAt", "id"`,
        [id],
      );
      expect(audits.rows.map((a) => [a.metadata.from, a.metadata.to])).toEqual([
        [null, 'PENDING'],
        ['PENDING', 'PAID'],
        ['PAID', 'PARTIALLY_REFUNDED'],
        ['PARTIALLY_REFUNDED', 'REFUNDED'],
      ]);
      expect(audits.rows.every((a) => a.tenantId === tenantAId)).toBe(true);
      // The unsigned notification has no principal: the system settled it.
      expect(audits.rows[1]).toMatchObject({ actorType: 'SYSTEM', actorId: null });
      expect(audits.rows[2].actorType).toBe('TENANT_USER');
      expect(audits.rows[2].actorId).not.toBeNull();

      // Outbox: one snapshot per change, in the same transaction, sequence per order.
      const events = await tenantRows<{
        sequence: number;
        eventType: string;
        payload: { sequence: number; data: Record<string, unknown> };
      }>(
        `SELECT "sequence", "eventType", "payload" FROM "${tenantASchema}"."payment_event_outbox"
         WHERE "orderId" = $1 ORDER BY "sequence"`,
        [id],
      );
      expect(events.map((e) => [e.sequence, e.eventType])).toEqual([
        [1, 'payment.paid'],
        [2, 'payment.refunded'],
        [3, 'payment.refunded'],
      ]);
      expect(events[1].payload.data).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refundedAmount: '100.00',
        refunded: '100.00',
        fullyRefunded: false,
      });
      expect(events[2].payload.data).toMatchObject({ status: 'REFUNDED', fullyRefunded: true });
    });

    it('lets only a role with payments:refund refund', async () => {
      const { id, row } = await createOrder(`E2E-REFUND-RBAC-${RUN_ID}`);
      const tx = `txn_refund_rbac_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      await waitForStatus(id, ['PAID']);
      for (const token of [viewerAccessToken, auditorAccessToken]) {
        const res = await call('POST', `/t/payments/orders/${id}/refund`, token, undefined, tenantHeader());
        expect(res.status).toBe(403);
      }
      expect((await orderRow(id)).status).toBe('PAID');
    });

    it('reverses a settled order at most once under concurrent refunds', async () => {
      const { id, row } = await createOrder(`E2E-RACE-REFUND-${RUN_ID}`);
      const tx = `txn_race_refund_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      await waitForStatus(id, ['PAID']);
      provider.calls.length = 0;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call('POST', `/t/payments/orders/${id}/refund`, ownerToken, undefined, tenantHeader()),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const reversals = provider.calls.filter(
        (c) => c.method === 'PUT' && c.path === `/v2/transactions/refundable_${tx}/refund`,
      );
      expect(reversals).toHaveLength(1);
      expect((await orderRow(id)).status).toBe('REFUNDED');
    });

    it('keeps the refund claim when the provider outcome is unknown, so a retry cannot reverse twice', async () => {
      const { id, row } = await createOrder(`E2E-RETRY-REFUND-${RUN_ID}`);
      const tx = `txn_retry_refund_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      await waitForStatus(id, ['PAID']);
      provider.failNext = 500;
      const failed = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(failed.status).toBe(504);
      expect(failed.body['error']).toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: true });
      expect((await orderRow(id)).status).toBe('PAID');
      // The cancellation may have been carried out: the claim stays for reconciliation.
      const retry = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(retry.status).toBe(409);
      expect((await orderRow(id)).status).toBe('PAID');
    });

    it('frees the order for a retry when the provider fails a charge, then refuses a repeat once submitted', async () => {
      const { id } = await createOrder(`E2E-RETRY-CHARGE-${RUN_ID}`);
      const body = { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE };
      provider.failNext = 500;
      // The 5xx hits the customer creation, before any charge was sent: nobody was
      // charged, so the claim is released and the retry may proceed.
      const failed = await call('POST', `/t/payments/orders/${id}/charge`, ownerToken, body, tenantHeader());
      expect(failed.status).toBe(504);
      const retry = await call('POST', `/t/payments/orders/${id}/charge`, ownerToken, body, tenantHeader());
      expect(retry.status).toBe(200);
      // Submitted and not yet reported unsuccessful: a third attempt would bill twice.
      const again = await call('POST', `/t/payments/orders/${id}/charge`, ownerToken, body, tenantHeader());
      expect(again.status).toBe(409);
    });

    it('charges an order at most once under concurrent charges', async () => {
      const { id } = await createOrder(`E2E-RACE-CHARGE-${RUN_ID}`);
      provider.calls.length = 0;
      const body = {
        cardToken: 'token_abcdefghijklmnop',
        billing: BILLING,
        ...DEVICE,
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call('POST', `/t/payments/orders/${id}/charge`, ownerToken, body, tenantHeader()),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(provider.calls.filter((c) => c.path === '/v3.5/charges/')).toHaveLength(1);
    });

    it('verifies a burst of identical notifications without corrupting the order', async () => {
      const { id, row } = await createOrder(`E2E-RACE-NOTIFY-${RUN_ID}`);
      const tx = `txn_race_notify_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      const replies = await Promise.all(Array.from({ length: 8 }, () => notify(row.orderReference, tx)));
      expect(replies.every((r) => r.status === 202)).toBe(true);
      const settled = await waitForStatus(id, ['PAID']);
      expect(settled.status).toBe('PAID');
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await orderRow(id)).status).toBe('PAID');
    });

    describe('Idempotency-Key (BN-TASK-010)', () => {
      const keyed = (key: string): Record<string, string> => ({ ...tenantHeader(), 'idempotency-key': key });
      const reversalsOf = (tx: string) =>
        provider.calls.filter(
          (c) => c.method === 'PUT' && c.path === `/v2/transactions/refundable_${tx}/refund`,
        );

      const paidOrder = async (code: string) => {
        const { id, row } = await createOrder(code);
        const tx = `txn_${code.toLowerCase()}`;
        provider.transactions.set(tx, { status: 'DONE', amount: 650 });
        await notify(row.orderReference, tx);
        await waitForStatus(id, ['PAID']);
        return { id, tx };
      };

      it('runs two concurrent refunds with one key once: one Netpay call, and the stored answer on retry', async () => {
        const { id, tx } = await paidOrder(`E2E-IDM-RACE-${RUN_ID}`);
        const key = `idm-race-${RUN_ID}`;
        provider.calls.length = 0;
        // The reversal answers slowly, so the second request arrives while the first runs.
        provider.delayPath = /\/refund$/;
        provider.delayMs = 1_000;
        const results = await Promise.all([
          call('POST', `/t/payments/orders/${id}/refund`, ownerToken, { motive: 'dup' }, keyed(key)),
          call('POST', `/t/payments/orders/${id}/refund`, ownerToken, { motive: 'dup' }, keyed(key)),
        ]);
        provider.delayPath = null;
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const busy = results.find((r) => r.status === 409) as Reply;
        expect(busy.body['error']).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', retryable: true });
        expect(busy.headers['retry-after']).toBe('2');
        expect(reversalsOf(tx)).toHaveLength(1);

        const first = results.find((r) => r.status === 200) as Reply;
        const retry = await call(
          'POST',
          `/t/payments/orders/${id}/refund`,
          ownerToken,
          { motive: 'dup' },
          keyed(key),
        );
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual(first.body);
        expect(retry.headers['idempotency-replayed']).toBe('true');
        expect(reversalsOf(tx)).toHaveLength(1);

        // The same key with another body is a client defect, not a repeat.
        const reused = await call(
          'POST',
          `/t/payments/orders/${id}/refund`,
          ownerToken,
          { motive: 'other' },
          keyed(key),
        );
        expect(reused.status).toBe(422);
        expect(reused.body['error']).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
        expect(reversalsOf(tx)).toHaveLength(1);
      });

      it('replays an order creation and a charge without calling Netpay again', async () => {
        const body = { merchantReferenceCode: `E2E-IDM-CREATE-${RUN_ID}`, amount: '650.00' };
        provider.calls.length = 0;
        const created = await call(
          'POST',
          '/t/payments/orders',
          ownerToken,
          body,
          keyed(`idm-create-${RUN_ID}`),
        );
        expect(created.status).toBe(201);
        // Key order in the body does not make it another request.
        const again = await call(
          'POST',
          '/t/payments/orders',
          ownerToken,
          { amount: '650.00', merchantReferenceCode: body.merchantReferenceCode },
          keyed(`idm-create-${RUN_ID}`),
        );
        expect(again.status).toBe(201);
        expect(again.body['id']).toBe(created.body['id']);
        expect(provider.calls.filter((c) => c.path === '/v3.2/checkout/session/')).toHaveLength(1);
        const orders = await tenantRows<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${tenantASchema}".payment_orders WHERE "merchantReferenceCode" = $1`,
          [body.merchantReferenceCode],
        );
        expect(orders[0].n).toBe('1');

        const { id } = await createOrder(`E2E-IDM-CHARGE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        const charge = { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE };
        provider.calls.length = 0;
        const charged = await call(
          'POST',
          `/t/payments/orders/${id}/charge`,
          ownerToken,
          charge,
          keyed(`idm-charge-${RUN_ID}`),
        );
        expect(charged.status).toBe(200);
        const replayed = await call(
          'POST',
          `/t/payments/orders/${id}/charge`,
          ownerToken,
          charge,
          keyed(`idm-charge-${RUN_ID}`),
        );
        expect(replayed.status).toBe(200);
        expect(replayed.body).toEqual(charged.body);
        expect(provider.calls.filter((c) => c.path === '/v3.5/charges/')).toHaveLength(1);
      });

      it('stores a definitive 4xx, and keeps a 5xx in progress so a retry cannot run twice', async () => {
        const { id } = await createOrder(`E2E-IDM-4XX-${RUN_ID}`);
        const refused = await call(
          'POST',
          `/t/payments/orders/${id}/refund`,
          ownerToken,
          undefined,
          keyed(`idm-4xx-${RUN_ID}`),
        );
        expect(refused.status).toBe(409);
        const replayed = await call(
          'POST',
          `/t/payments/orders/${id}/refund`,
          ownerToken,
          undefined,
          keyed(`idm-4xx-${RUN_ID}`),
        );
        expect(replayed.status).toBe(409);
        expect(replayed.body['error']).toEqual(refused.body['error']);
        expect(replayed.headers['idempotency-replayed']).toBe('true');

        const custom = await createOrder(`E2E-IDM-5XX-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        const charge = { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE };
        provider.failChargeNext = 500;
        const unknown = await call(
          'POST',
          `/t/payments/orders/${custom.id}/charge`,
          ownerToken,
          charge,
          keyed(`idm-5xx-${RUN_ID}`),
        );
        expect(unknown.status).toBe(504);
        const retry = await call(
          'POST',
          `/t/payments/orders/${custom.id}/charge`,
          ownerToken,
          charge,
          keyed(`idm-5xx-${RUN_ID}`),
        );
        expect(retry.status).toBe(409);
        expect(retry.body['error']).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
        const rows = await tenantRows<{ status: string; responseStatus: number; ttl: number }>(
          `SELECT status, "responseStatus", extract(epoch FROM ("expiresAt" - now()))::int AS ttl
           FROM "${tenantASchema}".idempotency_record WHERE key = $1`,
          [`idm-5xx-${RUN_ID}`],
        );
        expect(rows[0]).toMatchObject({ status: 'IN_PROGRESS', responseStatus: 504 });
        expect(rows[0].ttl).toBeGreaterThan(9 * 60);
        expect(rows[0].ttl).toBeLessThanOrEqual(10 * 60);
      });

      it('refuses a malformed key and leaves requests without one as they were', async () => {
        const { id } = await createOrder(`E2E-IDM-BAD-${RUN_ID}`);
        const bad = await call(
          'POST',
          `/t/payments/orders/${id}/refund`,
          ownerToken,
          undefined,
          keyed('has space'),
        );
        expect(bad.status).toBe(400);
        const plain = await call(
          'POST',
          `/t/payments/orders/${id}/refund`,
          ownerToken,
          undefined,
          tenantHeader(),
        );
        expect(plain.status).toBe(409);
        expect(plain.headers['idempotency-replayed']).toBeUndefined();
      });
    });

    describe('charge attempts and unknown outcomes (BN-TASK-014, BN-TASK-015)', () => {
      const charge = { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE };
      const chargeOf = (id: string) =>
        call('POST', `/t/payments/orders/${id}/charge`, ownerToken, charge, tenantHeader());
      const chargesSent = () =>
        provider.calls.filter((c) => c.method === 'POST' && c.path === '/v3.5/charges/');

      const attemptsOf = (id: string) =>
        tenantRows<{
          attemptNo: number;
          netpayTransactionId: string | null;
          status: string;
          declineCode: string | null;
        }>(
          `SELECT "attemptNo", "netpayTransactionId", status, "declineCode"
           FROM "${tenantASchema}".payment_attempt WHERE "orderId" = $1 ORDER BY "attemptNo"`,
          [id],
        );
      const eventsOf = (id: string) =>
        tenantRows<{ eventType: string; payload: { data: Record<string, unknown> } }>(
          `SELECT "eventType", payload FROM "${tenantASchema}".payment_event_outbox WHERE "orderId" = $1 ORDER BY sequence`,
          [id],
        );

      it('leaves the order CHARGE_UNKNOWN on a charge without answer, and refuses new charges until verify resolves it', async () => {
        const { id } = await createOrder(`E2E-UNKNOWN-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        provider.failChargeNext = 504;
        const first = await chargeOf(id);
        expect(first.status).toBe(504);
        expect(first.body['error']).toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' });
        expect((await orderRow(id)).status).toBe('CHARGE_UNKNOWN');
        expect(await attemptsOf(id)).toEqual([
          { attemptNo: 1, netpayTransactionId: null, status: 'UNKNOWN', declineCode: null },
        ]);

        provider.calls.length = 0;
        const again = await chargeOf(id);
        expect(again.status).toBe(409);
        expect(again.body['error']).toMatchObject({
          code: 'ORDER_STATE_CONFLICT',
          details: { status: 'CHARGE_UNKNOWN' },
        });
        expect(chargesSent()).toHaveLength(0);

        // Netpay cannot be searched by reference: the transaction id (Netpay Manager,
        // or the inbound notification) is what resolves it.
        const blind = await call('POST', `/t/payments/orders/${id}/verify`, ownerToken, {}, tenantHeader());
        expect(blind.status).toBe(400);
        const tx = `txn_unknown_${RUN_ID}`;
        provider.transactions.set(tx, { status: 'DONE', amount: 650 });
        const verified = await call(
          'POST',
          `/t/payments/orders/${id}/verify`,
          ownerToken,
          { transactionId: tx },
          tenantHeader(),
        );
        expect(verified.status).toBe(200);
        expect(verified.body['status']).toBe('PAID');
        expect((await orderRow(id)).netpayTransactionId).toBe(tx);
        expect(await attemptsOf(id)).toEqual([
          { attemptNo: 1, netpayTransactionId: tx, status: 'PAID', declineCode: null },
        ]);
        const events = await eventsOf(id);
        expect(
          events.map((e) => [
            e.eventType,
            e.payload.data['previousStatus'],
            e.payload.data['netpayTransactionId'],
          ]),
        ).toEqual([['payment.paid', 'CHARGE_UNKNOWN', tx]]);
      });

      it('accepts another card after a decline: attempt 2 settles the order, and each event names its attempt', async () => {
        const { id } = await createOrder(`E2E-ATTEMPT-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        provider.declineNext = true;
        const declined = await chargeOf(id);
        expect(declined.status).toBe(200);
        expect(declined.body['orderStatus']).toBe('FAILED');
        const tx1 = String(declined.body['transactionTokenId']);

        const second = await chargeOf(id);
        expect(second.status).toBe(200);
        expect(second.body['orderStatus']).toBe('PAID');
        const tx2 = String(second.body['transactionTokenId']);
        expect(tx2).not.toBe(tx1);
        expect((await orderRow(id)).netpayTransactionId).toBe(tx2);

        const attempts = await attemptsOf(id);
        expect(attempts.map((a) => [a.attemptNo, a.netpayTransactionId, a.status])).toEqual([
          [1, tx1, 'FAILED'],
          [2, tx2, 'PAID'],
        ]);
        expect(attempts[0].declineCode).not.toBeNull();
        const events = await eventsOf(id);
        expect(events.map((e) => [e.eventType, e.payload.data['netpayTransactionId']])).toEqual([
          ['payment.failed', tx1],
          ['payment.paid', tx2],
        ]);
      });

      it('verifies an abandoned 3-D Secure attempt with Netpay, then accepts a new charge', async () => {
        provider.threeDS = true;
        const { id } = await createOrder(`E2E-3DS-ABANDON-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        const challenged = await chargeOf(id);
        provider.threeDS = false;
        expect(challenged.status).toBe(200);
        const tx1 = String(challenged.body['transactionTokenId']);

        provider.calls.length = 0;
        const retry = await chargeOf(id);
        expect(retry.status).toBe(200);
        expect(retry.body['orderStatus']).toBe('PAID');
        // The previous attempt was asked about before the new charge was sent.
        const askedFirst = provider.calls.findIndex(
          (c) => c.method === 'GET' && c.path === `/v3/transactions/${tx1}`,
        );
        const charged = provider.calls.findIndex((c) => c.method === 'POST' && c.path === '/v3.5/charges/');
        expect(askedFirst).toBeGreaterThanOrEqual(0);
        expect(askedFirst).toBeLessThan(charged);
        const attempts = await attemptsOf(id);
        expect(attempts.map((a) => [a.attemptNo, a.status])).toEqual([
          [1, 'ABANDONED'],
          [2, 'PAID'],
        ]);
      });

      it('answers 409 with the PAID order when the previous attempt was charged after all', async () => {
        provider.threeDS = true;
        const { id } = await createOrder(`E2E-3DS-PAID-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        const challenged = await chargeOf(id);
        provider.threeDS = false;
        const tx1 = String(challenged.body['transactionTokenId']);
        // The buyer finished 3-D Secure elsewhere and Netpay charged the card.
        provider.transactions.set(tx1, { status: 'DONE', amount: 650 });

        provider.calls.length = 0;
        const retry = await chargeOf(id);
        expect(retry.status).toBe(409);
        expect(retry.body['error']).toMatchObject({ code: 'ORDER_STATE_CONFLICT' });
        const details = (retry.body['error'] as { details: { order: Record<string, unknown> } }).details;
        expect(details.order).toMatchObject({ id, status: 'PAID', netpayTransactionId: tx1 });
        expect(chargesSent()).toHaveLength(0);
        expect((await orderRow(id)).status).toBe('PAID');
      });
    });

    /** Delivers a Checkout Hosted notification the way Netpay shapes it: by session, with no order reference. */
    const notifyHosted = (
      sessionId: string,
      transactionId: string,
      event = 'sessionLink.paid',
      amount = '650.00',
    ) =>
      call('POST', `/payments/webhook/${webhookToken}`, undefined, {
        event,
        data: {
          sessionId,
          transactionId,
          amount,
          status: 'DONE',
          cardHolderName: 'John',
          lastFourDigits: '0002',
          responseCode: '00',
          procRetMsg: 'Aprobada',
          customerEmail: 'accept@netpay.com.mx',
          authDate: Date.now(),
          authCode: '123456',
          orderId: '1618267387448630012',
        },
        type: null,
        createdAt: Date.now(),
      });

    it('opens a Checkout Hosted session and returns the page Netpay hosts', async () => {
      const code = `E2E-HOSTED-${RUN_ID}`;
      const { res, row } = await createOrder(code, '650.00', {
        successUrl: 'https://shop.example.com/ok',
        cancelUrl: 'https://shop.example.com/no',
      });
      const checkout = res.body['checkout'] as Record<string, unknown>;
      expect(checkout['mode']).toBe('hosted');
      expect(String(checkout['hostedCheckoutUrl'])).toMatch(
        /^https:\/\/gateway-154\.netpaydev\.com\/hosted-checkout\/session\//,
      );
      expect(checkout['amountToken']).toBeNull();
      expect(row.checkoutSessionId).toMatch(/^sess_/);
      expect(String(checkout['hostedCheckoutUrl'])).toContain(String(row.checkoutSessionId));

      const sent = provider.calls.find((c) => c.path === '/v3.2/checkout/session/');
      expect(sent?.authorization).toBe(VALID_CONFIG.secretKey);
      expect(sent?.body['paymentMethodTypes']).toEqual(['card']);
      expect(sent?.body['linkType']).toBe('NETPAY_CHECKOUT');
      expect(sent?.body['merchantRefCode']).toBe(row.orderReference);
      expect(sent?.body['successUrl']).toBe('https://shop.example.com/ok');
      expect(sent?.body['cancelUrl']).toBe('https://shop.example.com/no');
      expect(sent?.body['lineItems']).toEqual([
        { name: code, amount: '650.00', quantity: '1', currency: 'MXN' },
      ]);
      // A hosted order never tokenises an amount: Netpay owns the page and the figure.
      expect(provider.calls.some((c) => c.path === '/v3/token/amount')).toBe(false);
    });

    it('refuses a hosted order that is not in MXN, and a malformed return URL', async () => {
      const usd = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-USD', amount: '10.00', currency: 'USD' },
        tenantHeader(),
      );
      expect(usd.status).toBe(400);
      const url = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        { merchantReferenceCode: 'E2E-URL', amount: '10.00', successUrl: 'javascript:alert(1)' },
        tenantHeader(),
      );
      expect(url.status).toBe(400);
      expect(provider.calls).toHaveLength(0);
    });

    it('settles a hosted payment from a notification that names only the session', async () => {
      const { id, row } = await createOrder(`E2E-HOSTED-PAID-${RUN_ID}`);
      const tx = `txn_hosted_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      const res = await notifyHosted(row.checkoutSessionId!, tx);
      expect(res.status).toBe(202);
      const paid = await waitForStatus(id, ['PAID']);
      expect(paid.status).toBe('PAID');
      expect(paid.verifiedAmount).toBe('650.00');
      expect(paid.netpayTransactionId).toBe(tx);
    });

    it('does not settle a hosted order from a notification whose transaction the provider never saw', async () => {
      const { id, row } = await createOrder(`E2E-HOSTED-FORGED-${RUN_ID}`);
      await notifyHosted(row.checkoutSessionId!, `txn_hosted_ghost_${RUN_ID}`);
      await new Promise((r) => setTimeout(r, 1_500));
      const after = await orderRow(id);
      expect(after.status).toBe('PENDING');
      expect(after.netpayTransactionId).toBeNull();
    });

    it('ignores a hosted notification for a session that belongs to no order', async () => {
      const res = await notifyHosted('sess_nobody', `txn_nobody_${RUN_ID}`);
      expect(res.status).toBe(202);
      const events = await tenantRows<{ outcome: string | null }>(
        `SELECT outcome FROM "${tenantASchema}".payment_webhook_events WHERE "netpayTransactionId" = $1`,
        [`txn_nobody_${RUN_ID}`],
      );
      expect(events[0]?.outcome).toBe('UNKNOWN_ORDER');
    });

    it('treats sessionLink.failed by what the provider reports, not by the event name', async () => {
      const { id, row } = await createOrder(`E2E-HOSTED-FAILED-${RUN_ID}`);
      const tx = `txn_hosted_failed_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'REJECT', amount: 650 });
      await notifyHosted(row.checkoutSessionId!, tx, 'sessionLink.failed');
      expect((await waitForStatus(id, ['FAILED'])).status).toBe('FAILED');
    });

    it('does not trust the amount in a hosted notification', async () => {
      const { id, row } = await createOrder(`E2E-HOSTED-AMOUNT-${RUN_ID}`);
      const tx = `txn_hosted_amount_${RUN_ID}`;
      // The payload claims 650.00; the provider says only 1.00 moved.
      provider.transactions.set(tx, { status: 'DONE', amount: 1 });
      await notifyHosted(row.checkoutSessionId!, tx, 'sessionLink.paid', '650.00');
      expect((await waitForStatus(id, ['AMOUNT_MISMATCH'])).status).toBe('AMOUNT_MISMATCH');
    });

    it.each([
      ['WAIT_THREEDS', 'PENDING_VERIFICATION'],
      ['REVIEW', 'PENDING_VERIFICATION'],
      ['CHARGEABLE', 'PENDING_VERIFICATION'],
      ['INSECURE', 'FAILED'],
      ['CANCELED', 'FAILED'],
      ['FAILED', 'FAILED'],
    ])('maps the provider status %s to %s', async (providerStatus, expected) => {
      const { id, row } = await createOrder(`E2E-MAP-${providerStatus}-${RUN_ID}`);
      const tx = `txn_map_${providerStatus}_${RUN_ID}`;
      provider.transactions.set(tx, { status: providerStatus, amount: 650 });
      await notifyHosted(row.checkoutSessionId!, tx);
      expect((await waitForStatus(id, [expected])).status).toBe(expected);
    });

    it('does not read the legacy status names as success', async () => {
      const { id, row } = await createOrder(`E2E-LEGACY-${RUN_ID}`);
      const tx = `txn_legacy_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'APPROVED', amount: 650 });
      await notifyHosted(row.checkoutSessionId!, tx);
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await orderRow(id)).status).not.toBe('PAID');
    });

    it('asks the provider for nothing when the storefront charges a token itself', async () => {
      const { res } = await createOrder(`E2E-CUSTOM-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      expect((res.body['checkout'] as Record<string, unknown>)['mode']).toBe('custom');
      expect(provider.calls).toHaveLength(0);
    });

    describe('3-D Secure', () => {
      const bill = BILLING;
      const chargeBody = { cardToken: 'token_abcdefghijklmnop', billing: bill, ...DEVICE };

      const chargeWithChallenge = async () => {
        provider.threeDS = true;
        const { id, row } = await createOrder(`E2E-3DS-${Date.now()}-${provider.counter}`, '650.00', {
          checkoutMode: 'custom',
        });
        const res = await call(
          'POST',
          `/t/payments/orders/${id}/charge`,
          ownerToken,
          chargeBody,
          tenantHeader(),
        );
        provider.threeDS = false;
        return { id, row, res };
      };

      it('hands the challenge back to the storefront', async () => {
        const { res } = await chargeWithChallenge();
        expect(res.status).toBe(200);
        expect(res.body['status']).toBe('review');
        const challenge = res.body['threeDSecureResponse'] as Record<string, unknown>;
        expect(challenge['status']).toBe('PROCEED_TO_VALIDATE_AUTHENTICATION');
        expect(challenge['acsUrl']).toBe('https://acs.example/challenge');
        expect(challenge['paReq']).toBe('paReq-value');
        expect(challenge['authenticationTransactionID']).toBe('auth-tx-1');
      });

      it('confirms once the buyer authenticated, and settles after the provider agrees', async () => {
        const { id, res } = await chargeWithChallenge();
        const tx = String(res.body['transactionTokenId']);
        provider.calls.length = 0;
        const confirmed = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          ownerToken,
          { processorTransactionId: 'proc-77' },
          tenantHeader(),
        );
        expect(confirmed.status).toBe(200);
        const sent = provider.calls.filter(
          (c) => c.method === 'POST' && c.path.startsWith(`/v3.5/charges/${tx}/confirm`),
        );
        expect(sent).toHaveLength(1);
        expect(sent[0].path).toContain('processorTransactionId=proc-77');
        expect(sent[0].authorization).toBe(VALID_CONFIG.secretKey);
        // The provider moved the charge to DONE on confirmation and the order followed.
        expect((await waitForStatus(id, ['PAID'])).status).toBe('PAID');
      });

      it('confirms with a null processor id when the library needed no challenge', async () => {
        const { id, res } = await chargeWithChallenge();
        const tx = String(res.body['transactionTokenId']);
        provider.calls.length = 0;
        const confirmed = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          ownerToken,
          { processorTransactionId: null },
          tenantHeader(),
        );
        expect(confirmed.status).toBe(200);
        const sent = provider.calls.filter((c) => c.path.startsWith(`/v3.5/charges/${tx}/confirm`));
        expect(sent).toHaveLength(1);
        expect(sent[0].path).toContain('processorTransactionId=null');
      });

      it('refuses to confirm a transaction that is not waiting for it', async () => {
        const { id } = await createOrder(`E2E-NOCONFIRM-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        const charged = await call(
          'POST',
          `/t/payments/orders/${id}/charge`,
          ownerToken,
          chargeBody,
          tenantHeader(),
        );
        expect(charged.status).toBe(200);
        provider.calls.length = 0;
        const res = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          ownerToken,
          { processorTransactionId: 'proc-1' },
          tenantHeader(),
        );
        expect(res.status).toBe(409);
        expect(provider.calls.some((c) => c.path.includes('/confirm'))).toBe(false);
      });

      it('refuses to confirm an order that has no charge', async () => {
        const { id } = await createOrder(`E2E-NOCHARGE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
        const res = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          ownerToken,
          { processorTransactionId: 'proc-1' },
          tenantHeader(),
        );
        expect(res.status).toBe(409);
      });

      it('confirms at most once under concurrent requests', async () => {
        const { id, res } = await chargeWithChallenge();
        const tx = String(res.body['transactionTokenId']);
        provider.calls.length = 0;
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            call(
              'POST',
              `/t/payments/orders/${id}/confirm`,
              ownerToken,
              { processorTransactionId: 'proc-9' },
              tenantHeader(),
            ),
          ),
        );
        expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
        expect(provider.calls.filter((c) => c.path.startsWith(`/v3.5/charges/${tx}/confirm`))).toHaveLength(
          1,
        );
      });

      it('requires the processor transaction id, and the payments:write permission', async () => {
        const { id } = await chargeWithChallenge();
        const missing = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          ownerToken,
          {},
          tenantHeader(),
        );
        expect(missing.status).toBe(400);
        const denied = await call(
          'POST',
          `/t/payments/orders/${id}/confirm`,
          viewerAccessToken,
          { processorTransactionId: 'proc-1' },
          tenantHeader(),
        );
        expect(denied.status).toBe(403);
      });
    });

    it('forwards the fingerprint and device data the browser produced while tokenising', async () => {
      const { id } = await createOrder(`E2E-DEVICE-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      const deviceInformation = {
        deviceChannel: 'Browser',
        httpBrowserColorDepth: '30',
        httpBrowserJavaEnabled: 'FALSE',
        httpBrowserJavaScriptEnabled: 'TRUE',
        httpBrowserLanguage: 'en-US',
        httpBrowserScreenHeight: '900',
        httpBrowserScreenWidth: '1440',
        httpBrowserTimeDifference: '300',
      };
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        {
          cardToken: 'token_abcdefghijklmnop',
          billing: BILLING,
          ...DEVICE,
          deviceFingerPrint: 'fingerprint-from-browser',
          deviceInformation,
        },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      const sent = provider.calls.find((c) => c.path === '/v3.5/charges/');
      expect(sent?.body['sessionId']).toBe('fingerprint-from-browser');
      expect(sent?.body['deviceFingerPrint']).toBe('fingerprint-from-browser');
      expect(sent?.body['deviceInformation']).toEqual(deviceInformation);
    });

    it('carries the refund motive to Netpay', async () => {
      const { id, row } = await createOrder(`E2E-MOTIVE-${RUN_ID}`);
      const tx = `txn_motive_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });
      await notify(row.orderReference, tx);
      await waitForStatus(id, ['PAID']);
      provider.calls.length = 0;
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/refund`,
        ownerToken,
        { motive: 'Customer changed their mind' },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      const put = provider.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/refund'));
      expect(put?.body['motive']).toBe('Customer changed their mind');
    });

    it('stores a buyer profile with a card and keeps only the token', async () => {
      const res = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        {
          identifier: `buyer-${RUN_ID}`,
          firstName: 'Ana',
          lastName: 'Lopez',
          email: 'ana@example.mx',
          phone: '5512345678',
          cardToken: 'token_abcdefghijklmnop',
        },
        tenantHeader(),
      );
      expect(res.status).toBe(201);
      expect(String(res.body['netpayCustomerId'])).toMatch(/^cus_/);
      expect(res.body['cardToken']).toBe('token_abcdefghijklmnop');
      // The real digits, as Netpay reports them, never the token's tail.
      expect(res.body['lastFourDigits']).toBe('4242');
      const rows = await tenantRows<{ defaultTokenId: string | null }>(
        `SELECT "defaultTokenId" FROM "${tenantASchema}".payment_customers WHERE "netpayCustomerId" = $1`,
        [res.body['netpayCustomerId']],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].defaultTokenId).toBe('token_abcdefghijklmnop');
    });

    it('creates a profile without a card', async () => {
      const res = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        {
          identifier: `buyer2-${RUN_ID}`,
          firstName: 'Beto',
          lastName: 'Ruiz',
          email: 'beto@example.mx',
          phone: '5500000000',
        },
        tenantHeader(),
      );
      expect(res.status).toBe(201);
      expect(res.body['cardToken']).toBeNull();
      expect(res.body['lastFourDigits']).toBeNull();
    });

    it('answers 504 and does not leak the secret when the provider fails the profile', async () => {
      provider.failNext = 500;
      const res = await call(
        'POST',
        '/t/payments/cards',
        ownerToken,
        {
          identifier: 'buyer-x',
          firstName: 'A',
          lastName: 'B',
          email: 'a@b.mx',
          phone: '1',
          cardToken: 'token_abcdefghijklmnop',
        },
        tenantHeader(),
      );
      expect(res.status).toBe(504);
      expect(JSON.stringify(res.body)).not.toContain(VALID_CONFIG.secretKey);
    });

    it('registers the inbound webhook URL with the provider', async () => {
      const url = `https://shop.example.com/api/v1/payments/webhook/${webhookToken}`;
      const res = await call(
        'POST',
        '/t/payments/config/webhook-register',
        ownerToken,
        { url },
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(res.body['registered']).toBe(true);
      const put = provider.calls.find((c) => c.method === 'PUT' && c.path === '/v3/webhooks/');
      expect(put?.body['webhook']).toBe(url);
      expect(put?.authorization).toBe(VALID_CONFIG.secretKey);
      const rows = await tenantRows<{ webhookRegisteredAt: Date | null }>(
        `SELECT "webhookRegisteredAt" FROM "${tenantASchema}".payment_provider_config WHERE active`,
      );
      expect(rows[0].webhookRegisteredAt).not.toBeNull();
    });

    it('lets a tenant use only its own provider keys', async () => {
      await createOrder(`E2E-KEYS-${RUN_ID}`);
      const auths = provider.calls.map((c) => c.authorization);
      expect(auths.length).toBeGreaterThan(0);
      expect(new Set(auths)).toEqual(new Set([VALID_CONFIG.secretKey]));
    });

    // -------------------------------------------------------------------------
    // Last wave: listing, cancellation, versioned config, drift, allowlists,
    // consumer revocation and the internal tick.
    // -------------------------------------------------------------------------

    /** Error code of the envelope (BN-REQ-API-002). */
    const errorCode = (body: Record<string, unknown>): unknown =>
      (body['error'] as { code?: unknown } | undefined)?.code;

    /** Event types written to the outbox for an order, in sequence order. */
    const outboxOf = async (id: string): Promise<string[]> =>
      (
        await tenantRows<{ eventType: string }>(
          `SELECT "eventType" FROM "${tenantASchema}".payment_event_outbox WHERE "orderId" = $1 ORDER BY sequence`,
          [id],
        )
      ).map((r) => r.eventType);

    it('pages 250 orders with a cursor and updatedSince, each once and in order (BN-TASK-017)', async () => {
      const code = `E2E-PAGE250-${RUN_ID}`;
      // Groups of three share an updatedAt, so the id tie-breaker is exercised too.
      await tenantRows(
        `INSERT INTO "${tenantASchema}".payment_orders
           (id,"tenantId","orderReference","merchantReferenceCode",amount,status,"createdAt","updatedAt")
         SELECT gen_random_uuid(), $1, $2 || '-' || i, $2, 10.00, 'PENDING', now(),
                date_trunc('second', now()) - interval '10 minutes' + (i / 3) * interval '1 second'
           FROM generate_series(1, 250) AS i`,
        [tenantAId, code],
      );
      const since = new Date(Date.now() - 60 * 60_000).toISOString();
      const seen: { id: string; updatedAt: string }[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `limit=100&merchantReferenceCode=${encodeURIComponent(code)}&updatedSince=${encodeURIComponent(since)}${cursor === null ? '' : `&cursor=${cursor}`}`;
        const page = await call('GET', `/t/payments/orders?${query}`, ownerToken, undefined, tenantHeader());
        expect(page.status).toBe(200);
        const items = page.body['items'] as {
          id: string;
          updatedAt: string;
          merchantReferenceCode: string;
        }[];
        expect(items.length).toBeLessThanOrEqual(100);
        seen.push(...items.map((o) => ({ id: o.id, updatedAt: o.updatedAt })));
        cursor = page.body['nextCursor'] as string | null;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(250);
      expect(new Set(seen.map((o) => o.id)).size).toBe(250);
      // Oldest change first: what an incremental sync stores as its watermark.
      const times = seen.map((o) => o.updatedAt);
      expect([...times].sort()).toEqual(times);

      const paidOnly = await call(
        'GET',
        `/t/payments/orders?status=PAID&merchantReferenceCode=${encodeURIComponent(code)}`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(paidOnly.body['items']).toEqual([]);
      for (const bad of ['cursor=forged', 'status=PAYED', 'updatedSince=yesterday']) {
        const res = await call('GET', `/t/payments/orders?${bad}`, ownerToken, undefined, tenantHeader());
        expect(res.status).toBe(400);
      }
    });

    it('reads one order with what a consumer reconciles against (BN-TASK-017)', async () => {
      const { id } = await createOrder(`E2E-FIELDS-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      provider.declineNext = true;
      const declined = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(declined.status).toBe(200);
      const paid = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(paid.body['orderStatus']).toBe('PAID');

      const one = await call('GET', `/t/payments/orders/${id}`, ownerToken, undefined, tenantHeader());

      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        status: 'PAID',
        verifiedAmount: '650.00',
        netpayTransactionId: paid.body['transactionTokenId'],
        refundedAmount: '0.00',
        failureCode: null,
        paidAfterCancelAt: null,
        attempts: {
          count: 2,
          items: [
            expect.objectContaining({ attemptNo: 1, status: 'FAILED' }),
            expect.objectContaining({ attemptNo: 2, status: 'PAID' }),
          ],
        },
      });
    });

    it('cancels an unpaid hosted order once, and refuses a charge afterwards (BN-TASK-018)', async () => {
      const { id } = await createOrder(`E2E-CANCEL-${RUN_ID}`);
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/cancel`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(200);
      expect(res.body['status']).toBe('CANCELLED');
      expect(await outboxOf(id)).toEqual(['payment.cancelled']);

      const again = await call(
        'POST',
        `/t/payments/orders/${id}/cancel`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(again.status).toBe(200);
      expect(await outboxOf(id)).toEqual(['payment.cancelled']);

      const charge = await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect(charge.status).toBe(409);
      expect(errorCode(charge.body)).toBe('ORDER_STATE_CONFLICT');
      const viewer = await call(
        'POST',
        `/t/payments/orders/${id}/cancel`,
        viewerAccessToken,
        undefined,
        tenantHeader(),
      );
      expect(viewer.status).toBe(403);
    });

    it('refuses to cancel a paid order (BN-TASK-018)', async () => {
      const { id } = await createOrder(`E2E-CANCEL-PAID-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      const res = await call(
        'POST',
        `/t/payments/orders/${id}/cancel`,
        ownerToken,
        undefined,
        tenantHeader(),
      );
      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('ORDER_STATE_CONFLICT');
      expect((await orderRow(id)).status).toBe('PAID');
    });

    it('keeps a cancelled order CANCELLED when it is paid anyway, and tells the consumer (BN-TASK-018)', async () => {
      const { id, row } = await createOrder(`E2E-LATE-${RUN_ID}`);
      expect(
        (await call('POST', `/t/payments/orders/${id}/cancel`, ownerToken, undefined, tenantHeader())).status,
      ).toBe(200);
      const tx = `txn_late_${RUN_ID}`;
      provider.transactions.set(tx, { status: 'DONE', amount: 650 });

      expect((await notifyHosted(row.checkoutSessionId!, tx)).status).toBe(202);

      const deadline = Date.now() + 15_000;
      let late:
        { status: string; paidAfterCancelAt: Date | null; netpayTransactionId: string | null } | undefined;
      while (Date.now() < deadline) {
        [late] = await tenantRows<{
          status: string;
          paidAfterCancelAt: Date | null;
          netpayTransactionId: string | null;
        }>(
          `SELECT status, "paidAfterCancelAt", "netpayTransactionId" FROM "${tenantASchema}".payment_orders WHERE id = $1`,
          [id],
        );
        if (late?.paidAfterCancelAt !== null && late !== undefined) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(late).toMatchObject({ status: 'CANCELLED', netpayTransactionId: tx });
      expect(late?.paidAfterCancelAt).not.toBeNull();
      expect(await outboxOf(id)).toEqual(['payment.cancelled', 'payment.paid_after_cancel']);
      const audit = await adminPool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM "audit_logs" WHERE "tenantId" = $1 AND action = 'payment.paid_after_cancel' AND "resourceId" = $2`,
        [tenantAId, id],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({
        outcome: 'LATE_PAYMENT_ON_CANCELLED',
        status: 'CANCELLED',
      });
      const view = await call('GET', `/t/payments/orders/${id}`, ownerToken, undefined, tenantHeader());
      expect(view.body['paidAfterCancelAt']).toEqual(expect.any(String));
    });

    it('accepts hosted return URLs only from the tenant allowlist once it is set (BN-TASK-021)', async () => {
      const set = await call(
        'PATCH',
        '/t/payments/config',
        ownerToken,
        { allowedReturnOrigins: ['https://shop.example.com'] },
        tenantHeader(),
      );
      expect(set.status).toBe(200);
      expect(set.body['allowedReturnOrigins']).toEqual(['https://shop.example.com']);

      for (const [successUrl, status] of [
        ['https://evil.example/phish', 422],
        ['http://shop.example.com/ok', 422],
      ] as const) {
        const res = await call(
          'POST',
          '/t/payments/orders',
          ownerToken,
          { merchantReferenceCode: `E2E-RET-${RUN_ID}`, amount: '10.00', successUrl },
          tenantHeader(),
        );
        expect(res.status).toBe(status);
        expect(errorCode(res.body)).toBe('RETURN_URL_NOT_ALLOWED');
      }
      const ok = await call(
        'POST',
        '/t/payments/orders',
        ownerToken,
        {
          merchantReferenceCode: `E2E-RET-${RUN_ID}`,
          amount: '10.00',
          successUrl: 'https://shop.example.com/ok',
        },
        tenantHeader(),
      );
      expect(ok.status).toBe(201);
      const badOrigin = await call(
        'PATCH',
        '/t/payments/config',
        ownerToken,
        { allowedReturnOrigins: ['http://shop.example.com'] },
        tenantHeader(),
      );
      expect(badOrigin.status).toBe(400);
    });

    it('charges only in the currencies the tenant is enabled for (BN-TASK-022)', async () => {
      const usd = {
        merchantReferenceCode: `E2E-USD-${RUN_ID}`,
        amount: '10.00',
        currency: 'USD',
        checkoutMode: 'custom',
      };
      const refused = await call('POST', '/t/payments/orders', ownerToken, usd, tenantHeader());
      expect(refused.status).toBe(422);
      expect(errorCode(refused.body)).toBe('CURRENCY_NOT_ENABLED');
      const enable = await call(
        'PATCH',
        '/t/payments/config',
        ownerToken,
        { allowedCurrencies: ['MXN', 'USD'] },
        tenantHeader(),
      );
      expect(enable.status).toBe(200);
      const accepted = await call('POST', '/t/payments/orders', ownerToken, usd, tenantHeader());
      expect(accepted.status).toBe(201);
      expect(accepted.body['currency']).toBe('USD');
    });

    it('reports drift of the webhook Netpay calls, and none once it is this deployment (BN-TASK-026)', async () => {
      provider.registeredWebhook = `https://betydeliv.replit.app/api/v1/payments/webhook/${webhookToken}`;
      const drifted = await call('GET', '/t/payments/config/webhook', ownerToken, undefined, tenantHeader());
      expect(drifted.status).toBe(200);
      expect(drifted.body).toMatchObject({
        drift: true,
        reason: 'origin',
        expected: 'https://api.example.com/api/v1/payments/webhook/{token}',
        webhook: 'https://betydeliv.replit.app/api/v1/payments/webhook/[REDACTED]',
      });
      expect(JSON.stringify(drifted.body)).not.toContain(webhookToken);
      const [stored] = await tenantRows<{ webhookDrift: boolean | null }>(
        `SELECT "webhookDrift" FROM "${tenantASchema}".payment_provider_config WHERE active`,
      );
      expect(stored?.webhookDrift).toBe(true);

      provider.registeredWebhook = `https://api.example.com/api/v1/payments/webhook/${webhookToken}`;
      const fine = await call('GET', '/t/payments/config/webhook', ownerToken, undefined, tenantHeader());
      expect(fine.body).toMatchObject({ drift: false, reason: 'match' });

      // The authenticated readiness report carries the cached summary; the public one does not.
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = httpRequest(
          `${BASE_URL}/health/ready`,
          { method: 'GET', headers: { authorization: `Bearer ${adminAccessToken}` } },
          (r) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () =>
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(ready['netpayWebhookDrift']).toMatchObject({
        status: expect.stringMatching(/^(ok|drift|unknown)$/) as unknown,
      });
      expect((await root('/health/ready')).body).not.toHaveProperty('netpayWebhookDrift');
    });

    it('refunds an old order with the configuration it was created with, after a key change (BN-TASK-024)', async () => {
      const { id } = await createOrder(`E2E-CFG-V1-${RUN_ID}`, '650.00', { checkoutMode: 'custom' });
      await call(
        'POST',
        `/t/payments/orders/${id}/charge`,
        ownerToken,
        { cardToken: 'token_abcdefghijklmnop', billing: BILLING, ...DEVICE },
        tenantHeader(),
      );
      expect((await orderRow(id)).status).toBe('PAID');

      const changed = await call(
        'POST',
        '/t/payments/config',
        ownerToken,
        { ...VALID_CONFIG, secretKey: 'sk_netpay_e2esecondkey' },
        tenantHeader(),
      );
      expect(changed.status).toBe(200);
      // A new secret means a new webhook URL: a new token, shown once, to register again.
      const newToken = String(changed.body['webhookToken']);
      expect(newToken.length).toBeGreaterThanOrEqual(24);
      expect(newToken).not.toBe(webhookToken);
      const versions = await tenantRows<{
        version: number;
        active: boolean;
        webhookRegisteredAt: Date | null;
      }>(
        `SELECT version, active, "webhookRegisteredAt" FROM "${tenantASchema}".payment_provider_config ORDER BY version`,
      );
      expect(versions.filter((v) => v.active)).toHaveLength(1);
      expect(versions[versions.length - 1]).toMatchObject({ active: true, webhookRegisteredAt: null });
      // Only the new token still routes to this tenant.
      const routes = await adminPool.query<{ live: string }>(
        `SELECT count(*)::text AS live FROM "payment_webhook_registry" WHERE "tenantId" = $1 AND "revokedAt" IS NULL`,
        [tenantAId],
      );
      expect(routes.rows[0]?.live).toBe('1');
      webhookToken = newToken;

      provider.calls.length = 0;
      const refund = await call('POST', `/t/payments/orders/${id}/refund`, ownerToken, {}, tenantHeader());
      expect(refund.status).toBe(200);
      const auths = new Set(provider.calls.map((c) => c.authorization ?? c.apiKey));
      expect(auths).toEqual(new Set([VALID_CONFIG.secretKey]));

      provider.calls.length = 0;
      await createOrder(`E2E-CFG-V2-${RUN_ID}`);
      expect(new Set(provider.calls.map((c) => c.authorization))).toEqual(
        new Set(['sk_netpay_e2esecondkey']),
      );
    });
  });
  describe('consumer disconnect and internal routes', () => {
    it('lets a consumer disconnect: disable its endpoint and revoke its own key (BN-TASK-050)', async () => {
      const issued = await call(
        'POST',
        '/api-keys',
        ownerToken,
        { name: `consumer-${RUN_ID}`, scopes: ['admin:*', 'webhooks:read', 'webhooks:write'] },
        tenantHeader(),
      );
      expect(issued.status).toBe(201);
      const key = String(issued.body['secret']);
      const keyId = String(issued.body['id']);
      const endpoint = await call(
        'POST',
        '/t/webhooks',
        key,
        { url: 'https://8.8.4.4/consumer', events: ['payment.paid'] },
        tenantHeader(),
      );
      expect(endpoint.status).toBe(201);
      const endpointId = String(
        (endpoint.body['endpoint'] as Record<string, unknown> | undefined)?.['id'] ?? endpoint.body['id'],
      );

      const disabled = await call(
        'POST',
        `/t/webhooks/${endpointId}/disable`,
        key,
        undefined,
        tenantHeader(),
      );
      expect(disabled.status).toBe(204);
      const [row] = await tenantRows<{ status: string }>(
        `SELECT status FROM "${tenantASchema}".webhook_endpoints WHERE id = $1`,
        [endpointId],
      );
      // The dispatcher fans events out to ACTIVE endpoints only.
      expect(row?.status).toBe('DISABLED');

      const revoked = await call('DELETE', `/api-keys/${keyId}`, key, undefined, tenantHeader());
      expect(revoked.status).toBe(200);
      expect(revoked.body['status']).toBe('REVOKED');

      const after = await call('GET', '/t/webhooks', key, undefined, tenantHeader());
      expect(after.status).toBe(401);
      // The stable envelope (BN-REQ-API-002).
      expect(after.body).toMatchObject({
        error: { code: 'INVALID_API_KEY', retryable: false },
        requestId: expect.any(String) as unknown,
      });
    });

    it('accepts POST /internal/tick only with the scheduler’s Google ID token (BN-TASK-016)', async () => {
      const tick = (authorization?: string) =>
        new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
          const req = httpRequest(
            `${BASE_URL}/internal/tick`,
            { method: 'POST', headers: authorization === undefined ? {} : { authorization } },
            (r) => {
              const chunks: Buffer[] = [];
              r.on('data', (c: Buffer) => chunks.push(c));
              r.on('end', () =>
                resolve({
                  status: r.statusCode ?? 0,
                  body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        });
      for (const authorization of [
        undefined,
        'Bearer not-a-token',
        `Bearer ${ownerToken}`,
        `Bearer ${adminAccessToken}`,
      ]) {
        const res = await tick(authorization);
        expect(res.status).toBe(401);
        expect((res.body['error'] as { code?: unknown } | undefined)?.code).toBe('UNAUTHENTICATED');
      }
      // Internal routes live outside the versioned API.
      expect((await call('POST', '/internal/tick', ownerToken)).status).toBe(404);
    });
  });
});
