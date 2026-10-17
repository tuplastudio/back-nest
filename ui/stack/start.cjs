/**
 * Starts everything the test UI needs, seeds accounts, and cleans up on exit.
 *
 *   npm run stack        (from ui/, in one terminal)
 *   npm run dev          (from ui/, in another)
 *
 * It starts the stand-in Netpay on :4070 and the compiled backend on :4062 with
 * NODE_ENV=test, which is the only mode in which the backend honours
 * NETPAY_SANDBOX_BASE_URL. It then creates a tenant with a platform OWNER and
 * AUDITOR and tenant OWNER, ADMIN and VIEWER accounts, and writes their
 * credentials to public/stack.json for the page to read.
 *
 * Nothing here touches Netpay: use a real sandbox only with the backend started
 * outside this script.
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const req = (m) => require(path.join(ROOT, m));
const { startFakeNetpay } = require('./fake-netpay.cjs');

// Keys from ui/.env.local. They are used here, on the server side, to configure the
// demo tenant; the secret is never written to stack.json or sent to the browser.
const NETPAY_PK = process.env.NETPAY_PK || '';
const NETPAY_SK = process.env.NETPAY_SK || '';
const HAS_KEYS = /^pk_netpay_[A-Za-z0-9]+$/.test(NETPAY_PK) && /^sk_netpay_[A-Za-z0-9]+$/.test(NETPAY_SK);
// Real Netpay sandbox when keys are present (NETPAY_REAL=0 forces the stand-in),
// or when asked for explicitly with NETPAY_REAL=1 and keys typed into the page.
const REAL_PROVIDER = process.env.NETPAY_REAL === '1' || (process.env.NETPAY_REAL !== '0' && HAS_KEYS);
const BACKEND_PORT = 4062;
const FAKE_PORT = 4070;
const API = `http://127.0.0.1:${BACKEND_PORT}/api/v1`;
const RUN = crypto.randomBytes(3).toString('hex');
const SLUG = `demo-${RUN}`;
const HMAC = 'ui-blind-index-key';
const ENC = crypto.randomBytes(32).toString('base64');
const PASSWORD = 'Demo-Passw0rd!x1';

function call(method, p, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      `${API}${p}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const ch = [];
        res.on('data', (c) => ch.push(c));
        res.on('end', () => {
          const text = Buffer.concat(ch).toString();
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.CONTROL_PLANE_DATABASE_URL) {
    throw new Error(
      'CONTROL_PLANE_DATABASE_URL is not set. Run this through `npm run stack` so ../.env is loaded.',
    );
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
    console.log('dist/ not found, building the backend first...');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  }

  const { Pool } = req('node_modules/pg');
  const { PasswordService } = req('dist/auth/password.service');
  const { PiiCryptoService } = req('dist/pii/pii-crypto.service');

  const fake = await startFakeNetpay(FAKE_PORT);
  console.log(
    REAL_PROVIDER
      ? 'provider               REAL Netpay sandbox (stand-in not used)'
      : `stand-in Netpay        http://127.0.0.1:${FAKE_PORT}`,
  );

  const backend = spawn('node', ['dist/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(BACKEND_PORT),
      API_PREFIX: 'api/v1',
      API_BASE_DOMAIN: 'api.example.com',
      DOCS_ENABLED: 'false',
      JWT_ACCESS_SECRET: 'ui-access-secret-at-least-32-characters!',
      JWT_REFRESH_SECRET: 'ui-refresh-secret-at-least-32-characters',
      PII_HMAC_KEY: HMAC,
      PII_ENCRYPTION_KEY: ENC,
      OUTBOUND_WEBHOOK_ENABLED: 'false',
      THROTTLE_LIMIT: '100000',
      AUTH_THROTTLE_LIMIT: '1000',
      ...(REAL_PROVIDER
        ? {}
        : {
            NETPAY_SANDBOX_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/gateway-ecommerce`,
            NETPAY_SANDBOX_REPORTS_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/reports-sandbox`,
          }),
      NETPAY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  backend.stdout.on('data', (c) => (log += c));
  backend.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 160; i++) {
    if (backend.exitCode !== null) throw new Error(`backend exited early:\n${log.slice(-3000)}`);
    try {
      const status = await new Promise((res, rej) =>
        http.get(`http://127.0.0.1:${BACKEND_PORT}/health/live`, (r) => res(r.statusCode)).on('error', rej),
      );
      if (status === 200) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  console.log(`backend                http://127.0.0.1:${BACKEND_PORT}`);

  const admin = new Pool({ connectionString: process.env.CONTROL_PLANE_DATABASE_URL, max: 2 });
  const tenantPool = new Pool({ connectionString: process.env.CONTROL_PLANE_DATABASE_URL, max: 2 });
  const pii = new PiiCryptoService(HMAC, ENC);
  const passwords = new PasswordService({ argon2MemoryCost: 19456, argon2TimeCost: 2, argon2Parallelism: 1 });

  const platformEmails = [];
  const seedPlatform = async (label, role, roleName) => {
    const email = `${label}-${RUN}@demo.test`;
    platformEmails.push(email);
    const row = await admin.query(
      `INSERT INTO "platform_admins" (id,"emailCiphertext","emailLookup","emailMasked","passwordHash","displayName",role,status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'d***@demo.test',$3,$4,$5,'ACTIVE',now(),now()) RETURNING id`,
      [
        pii.encrypt(email, { aad: 'platform-admin.email' }),
        pii.blindIndex(email),
        await passwords.hash(PASSWORD),
        `Demo ${label}`,
        role,
      ],
    );
    await admin.query(
      `INSERT INTO "platform_admin_roles" ("adminId","roleId") SELECT $1, id FROM "roles" WHERE name = $2`,
      [row.rows[0].id, roleName],
    );
    return email;
  };
  const ownerEmail = await seedPlatform('platform-owner', 'OWNER', 'platform-owner');
  const auditorEmail = await seedPlatform('platform-auditor', 'AUDITOR', 'platform-auditor');

  const signed = await call('POST', '/auth/sign-in', undefined, { email: ownerEmail, password: PASSWORD });
  const tenant = await call('POST', '/tenants', signed.body.accessToken, { slug: SLUG, name: `Demo ${RUN}` });
  if (tenant.status !== 201) throw new Error(`could not create the tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.id;
  const schema = tenant.body.schemaName;

  // A tenant OWNER cannot be granted through the API, so it is seeded directly.
  const tenantOwnerEmail = `tenant-owner-${RUN}@demo.test`;
  const unit = await tenantPool.connect();
  try {
    await unit.query('BEGIN');
    await unit.query(`SET LOCAL app.current_tenant = '${schema}'`);
    await unit.query(
      `INSERT INTO "${schema}".users (id,"emailCiphertext","emailLookup","emailMasked","passwordHash","displayName",role,status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'t***@demo.test',$3,'Demo Tenant Owner','OWNER','ACTIVE',now(),now())`,
      [
        pii.encrypt(tenantOwnerEmail, { aad: 'tenant-user.email' }),
        pii.blindIndex(tenantOwnerEmail),
        await passwords.hash(PASSWORD),
      ],
    );
    const roleRow = await admin.query(`SELECT id FROM "roles" WHERE name = 'tenant-owner'`);
    await unit.query(
      `INSERT INTO "${schema}".user_roles ("userId","roleId") SELECT id, $2::uuid FROM "${schema}".users WHERE "emailLookup" = $1`,
      [pii.blindIndex(tenantOwnerEmail), roleRow.rows[0].id],
    );
    await unit.query('COMMIT');
  } finally {
    unit.release();
  }

  const T = { 'x-tenant-id': tenantId };
  const ownerSession = await call(
    'POST',
    '/t/auth/sign-in',
    undefined,
    { email: tenantOwnerEmail, password: PASSWORD },
    T,
  );
  const adminEmail = `tenant-admin-${RUN}@demo.test`;
  const viewerEmail = `tenant-viewer-${RUN}@demo.test`;
  for (const [email, name, role] of [
    [adminEmail, 'Demo Tenant Admin', 'ADMIN'],
    [viewerEmail, 'Demo Tenant Viewer', 'VIEWER'],
  ]) {
    const made = await call(
      'POST',
      '/t/users',
      ownerSession.body.accessToken,
      { email, displayName: name, password: PASSWORD, role },
      T,
    );
    if (made.status !== 201) throw new Error(`could not create ${role}: ${JSON.stringify(made.body)}`);
  }

  // With keys available the demo tenant is configured up front, against the
  // provider the stack is running with. Only the public key goes to the page.
  let netpay = null;
  if (HAS_KEYS && REAL_PROVIDER) {
    const saved = await call(
      'POST',
      '/t/payments/config',
      ownerSession.body.accessToken,
      { publicKey: NETPAY_PK, secretKey: NETPAY_SK, environment: 'SANDBOX' },
      T,
    );
    if (saved.status !== 200)
      throw new Error(`could not store the Netpay keys: ${JSON.stringify(saved.body)}`);
    netpay = { publicKey: NETPAY_PK, environment: 'SANDBOX', webhookToken: saved.body.webhookToken };
  }

  const stack = {
    tenantId,
    tenantSlug: SLUG,
    password: PASSWORD,
    realProvider: REAL_PROVIDER,
    netpay,
    accounts: [
      { key: 'tenantOwner', label: 'Tenant OWNER', kind: 'tenant', email: tenantOwnerEmail },
      { key: 'tenantAdmin', label: 'Tenant ADMIN', kind: 'tenant', email: adminEmail },
      { key: 'tenantViewer', label: 'Tenant VIEWER', kind: 'tenant', email: viewerEmail },
      { key: 'platformOwner', label: 'Platform OWNER', kind: 'platform', email: ownerEmail },
      { key: 'platformAuditor', label: 'Platform AUDITOR', kind: 'platform', email: auditorEmail },
    ],
  };
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'stack.json'), JSON.stringify(stack, null, 2));

  console.log('\nready. Accounts (password for all: ' + PASSWORD + '):');
  for (const a of stack.accounts) console.log(`  ${a.label.padEnd(18)} ${a.email}`);
  if (netpay) console.log(`\nNetpay sandbox keys loaded into the tenant (public key ${netpay.publicKey}).`);
  console.log(
    `\ntenant ${SLUG}  (${tenantId})\nNow run \`npm run dev\` in another terminal and open http://127.0.0.1:4321\nCtrl+C here removes the demo data.\n`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\ncleaning up...');
    backend.kill('SIGTERM');
    await sleep(1200);
    try {
      await admin.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [tenantId]);
      await admin.query('DELETE FROM "payment_webhook_registry" WHERE "tenantId" = $1', [tenantId]);
      await admin.query('DELETE FROM "tenants" WHERE "id" = $1', [tenantId]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const lookups = platformEmails.map((e) => pii.blindIndex(e));
      await admin.query(
        'DELETE FROM "admin_refresh_tokens" WHERE "adminId" IN (SELECT id FROM "platform_admins" WHERE "emailLookup" = ANY($1))',
        [lookups],
      );
      await admin.query('DELETE FROM "platform_admins" WHERE "emailLookup" = ANY($1)', [lookups]);
    } catch (error) {
      console.error('cleanup failed:', error.message);
    }
    await admin.end();
    await tenantPool.end();
    fake.close();
    try {
      fs.unlinkSync(path.join(__dirname, '..', 'public', 'stack.json'));
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  backend.on('exit', (code) => {
    if (!closing) {
      console.error(`backend stopped (code ${code}). Last output:\n${log.slice(-2000)}`);
      shutdown();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
