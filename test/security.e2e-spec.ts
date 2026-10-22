import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';
import { PiiMaskService } from '../src/pii/pii-mask.service';
import { PasswordService } from '../src/auth/password.service';
import { base32Decode, totpAt } from '../src/auth/totp';
import type { AppConfig } from '../src/config/app-config.service';

/**
 * Security hardening end to end (BN-TASK-029, 031, 032, 034, 038, 039).
 *
 * Boots the compiled app with `MFA_REQUIRED_FOR_ADMINS=true` (the production
 * default) and a staging-like CORS allow-list, and drives it over HTTP, like
 * `multitenant.e2e-spec.ts`. Needs a disposable database already migrated and
 * seeded with the RBAC catalogue (`npm run prisma:seed`), as in CI.
 */

const PORT = Number(process.env['SECURITY_E2E_PORT'] ?? 3987);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `${BASE_URL}/api/v1`;
const DATABASE_URL = process.env['CONTROL_PLANE_DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('CONTROL_PLANE_DATABASE_URL is required for the end-to-end suite.');
}

const RUN_ID = randomBytes(4).toString('hex');
const SLUG = `sec-${RUN_ID}`;
const ADMIN_EMAIL = `e2e-sec-${RUN_ID}@example.test`;
const ADMIN_PASSWORD = 'E2e-Security-Passphrase!1';
const NEW_ADMIN_PASSWORD = 'E2e-Rotated-Passphrase!2';
const STAGING_ORIGIN = 'https://vondi.tupla.dev';
const JWT_ACCESS_SECRET = process.env['JWT_ACCESS_SECRET'] ?? 'e2e-access-secret-at-least-32-characters-long';
const PII_HMAC_KEY = process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key';
const PII_ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64');

let server: ChildProcess;
let pool: Pool;
const serverOutput: string[] = [];
const crypto = new PiiCryptoService(PII_HMAC_KEY, PII_ENCRYPTION_KEY);
let adminToken = '';
let tenantId = '';
let mfaSecret = '';
/** Admin sign-ins issued so far, to predict where the auth throttler trips. */
let adminSignIns = 0;

type Res = { status: number; body: Record<string, unknown>; headers: Headers };

/**
 * Reads the machine error code whether the body carries it flat (`error:
 * 'CODE'`) or nested (`error: { code }`).
 *
 * @param body Response body.
 * @returns The code, if any.
 */
function errorCode(body: Record<string, unknown>): unknown {
  const error = body['error'];
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : error;
}

async function api(
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string;
    tenant?: string;
    headers?: Record<string, string>;
    root?: boolean;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.tenant) {
    headers['X-Tenant-Id'] = options.tenant;
  }
  const response = await fetch(`${options.root ? BASE_URL : API}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

/** Current TOTP for the enrolled secret, one step ahead to avoid replay refusal. */
function totp(offsetSteps = 0): string {
  return totpAt(base32Decode(mfaSecret), Math.floor(Date.now() / 30_000) + offsetSteps);
}

async function signInAdmin(password: string, otp?: string): Promise<Res> {
  adminSignIns += 1;
  return api('POST', '/auth/sign-in', { body: { email: ADMIN_EMAIL, password, ...(otp ? { otp } : {}) } });
}

describe('Security hardening (e2e)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const passwords = new PasswordService({
      argon2MemoryCost: 19_456,
      argon2TimeCost: 2,
      argon2Parallelism: 1,
    } as AppConfig);
    await pool.query(
      `INSERT INTO "platform_admins"
         ("id", "emailCiphertext", "emailLookup", "emailMasked", "passwordHash", "displayName", "role", "status", "passwordChangedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'E2E Security', 'OWNER', 'ACTIVE', now(), now(), now())`,
      [
        crypto.encrypt(ADMIN_EMAIL, { aad: 'platform-admin.email' }),
        crypto.blindIndex(ADMIN_EMAIL),
        new PiiMaskService().maskEmail(ADMIN_EMAIL),
        await passwords.hash(ADMIN_PASSWORD),
      ],
    );
    await pool.query(
      `INSERT INTO "platform_admin_roles" ("adminId", "roleId")
       SELECT a.id, r.id FROM "platform_admins" a, "roles" r
       WHERE a."emailLookup" = $1 AND r.name = 'platform-owner'`,
      [crypto.blindIndex(ADMIN_EMAIL)],
    );

    server = spawn('node', [process.env['SECURITY_E2E_ENTRY'] ?? 'dist/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        API_PREFIX: 'api/v1',
        API_BASE_DOMAIN: 'api.example.com',
        DOCS_ENABLED: 'false',
        CORS_ORIGINS: STAGING_ORIGIN,
        MFA_REQUIRED_FOR_ADMINS: 'true',
        AUTH_THROTTLE_LIMIT: '10',
        AUTH_THROTTLE_TTL: '60s',
        JWT_ACCESS_SECRET,
        JWT_REFRESH_SECRET:
          process.env['JWT_REFRESH_SECRET'] ?? 'e2e-refresh-secret-at-least-32-characters-long',
        PII_HMAC_KEY,
        PII_ENCRYPTION_KEY,
        NETPAY_ENCRYPTION_KEY: process.env['NETPAY_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = (chunk: Buffer): void => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 40) {
        serverOutput.shift();
      }
    };
    server.stdout?.on('data', tail);
    server.stderr?.on('data', tail);
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (server.exitCode !== null) {
        throw new Error(`Server exited early with code ${server.exitCode}.\n${serverOutput.join('').trim()}`);
      }
      if (Date.now() > deadline) {
        throw new Error('Server did not become ready in time.');
      }
      try {
        if ((await fetch(`${BASE_URL}/health/live`)).ok) {
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, 120_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      let fallback: NodeJS.Timeout | undefined;
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => {
          fallback = setTimeout(resolve, 10_000);
        }),
      ]);
      clearTimeout(fallback);
      if (server.exitCode === null) {
        server.kill('SIGKILL');
      }
    }
    const tenants = await pool.query<{ id: string; schemaName: string }>(
      `SELECT "id", "schemaName" FROM "tenants" WHERE "slug" = $1`,
      [SLUG],
    );
    for (const tenant of tenants.rows) {
      await pool.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [tenant.id]);
      await pool.query('DELETE FROM "api_keys" WHERE "tenantId" = $1', [tenant.id]);
      await pool.query('DELETE FROM "payment_webhook_registry" WHERE "tenantId" = $1', [tenant.id]);
      await pool.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant.id]);
      await pool.query(`DROP SCHEMA IF EXISTS "${tenant.schemaName}" CASCADE`);
    }
    const admin = await pool.query<{ id: string }>(
      `SELECT "id" FROM "platform_admins" WHERE "emailLookup" = $1`,
      [crypto.blindIndex(ADMIN_EMAIL)],
    );
    for (const row of admin.rows) {
      await pool.query('DELETE FROM "admin_refresh_tokens" WHERE "adminId" = $1', [row.id]);
      await pool.query('DELETE FROM "platform_admin_roles" WHERE "adminId" = $1', [row.id]);
      await pool.query('UPDATE "tenants" SET "createdById" = NULL WHERE "createdById" = $1', [row.id]);
      await pool.query('DELETE FROM "audit_logs" WHERE "actorId" = $1', [row.id]);
      await pool.query('DELETE FROM "platform_admins" WHERE "id" = $1', [row.id]);
    }
    await pool.end();
  }, 60_000);

  // --- BN-TASK-032: health is never throttled -------------------------------
  it('never answers 429 to 30 readiness probes a minute, and does not count them', async () => {
    for (let i = 0; i < 30; i++) {
      const response = await api('GET', '/health/ready', { root: true });
      expect(response.status).not.toBe(429);
      expect(response.headers.get('x-ratelimit-limit-auth')).toBeNull();
      expect(response.headers.get('x-ratelimit-limit')).toBeNull();
    }
  });

  // --- BN-TASK-034: MFA for platform admins ---------------------------------
  it('refuses an admin without MFA with 403 MFA_REQUIRED', async () => {
    const signIn = await signInAdmin(ADMIN_PASSWORD);
    expect(signIn.status).toBe(200);
    expect(signIn.body['mfaRequired']).toBe(true);
    // Credential endpoints carry the auth throttler's budget headers.
    expect(signIn.headers.get('x-ratelimit-limit-auth')).toBe('10');
    adminToken = signIn.body['accessToken'] as string;

    const tenants = await api('GET', '/tenants', { token: adminToken });
    expect(tenants.status).toBe(403);
    expect(errorCode(tenants.body)).toBe('MFA_REQUIRED');

    // A public route is not part of the protected surface: the same session is
    // answered there as an anonymous caller would be, not with 403.
    const ready = await api('GET', '/health/ready', { root: true, token: adminToken });
    expect(ready.status).not.toBe(403);
    expect(Object.keys(ready.body).sort()).toEqual(['status', 'timestamp']);
  });

  it('enrols TOTP, confirms it and unlocks the control plane', async () => {
    const enroll = await api('POST', '/auth/mfa/enroll', { token: adminToken });
    expect(enroll.status).toBe(200);
    mfaSecret = enroll.body['secret'] as string;
    expect(enroll.body['otpauthUrl']).toContain('otpauth://totp/');

    const confirm = await api('POST', '/auth/mfa/confirm', { token: adminToken, body: { code: totp() } });
    expect(confirm.status).toBe(200);
    expect(confirm.body['recoveryCodes']).toHaveLength(10);
    expect(confirm.body['mfaRequired']).toBe(false);
    adminToken = confirm.body['accessToken'] as string;

    expect((await api('GET', '/tenants', { token: adminToken })).status).toBe(200);
  });

  it('requires the second factor at sign-in once enrolled', async () => {
    const noCode = await signInAdmin(ADMIN_PASSWORD);
    expect(noCode.body['mfaRequired']).toBe(true);
    expect((await api('GET', '/tenants', { token: noCode.body['accessToken'] as string })).status).toBe(403);

    const verify = await api('POST', '/auth/mfa/verify', {
      token: noCode.body['accessToken'] as string,
      body: { code: totp(1) },
    });
    expect(verify.status).toBe(200);
    adminToken = verify.body['accessToken'] as string;
    expect((await api('GET', '/tenants', { token: adminToken })).status).toBe(200);
  });

  it('provisions the tenant used below', async () => {
    const created = await api('POST', '/tenants', {
      token: adminToken,
      body: { slug: SLUG, name: 'Security Corp' },
    });
    expect(created.status).toBe(201);
    tenantId = created.body['id'] as string;
  });

  it('requires a step-up (MFA within 5 min) for a cross-tenant payment write', async () => {
    const jwt = new JwtService();
    const me = await pool.query<{ id: string }>(
      `SELECT "id" FROM "platform_admins" WHERE "emailLookup" = $1`,
      [crypto.blindIndex(ADMIN_EMAIL)],
    );
    // Same issuer and audience as a genuine token; only the MFA time differs.
    const genuine = JSON.parse(Buffer.from(adminToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      iss: string;
      aud: string;
    };
    const sign = (mfa: number): string =>
      jwt.sign(
        {
          sub: me.rows[0]?.id,
          jti: randomBytes(8).toString('hex'),
          typ: 'access',
          kind: 'platform-admin',
          mfa,
        },
        { secret: JWT_ACCESS_SECRET, expiresIn: 300, issuer: genuine.iss, audience: genuine.aud },
      );
    const order = { amount: '10.00', currency: 'MXN', description: 'step-up probe' };

    const stale = await api('POST', '/t/payments/orders', {
      token: sign(Math.floor(Date.now() / 1000) - 600),
      tenant: tenantId,
      body: order,
    });
    expect(stale.status).toBe(403);
    expect(errorCode(stale.body)).toBe('STEP_UP_REQUIRED');

    // A read is not a step-up operation.
    const read = await api('GET', '/t/payments/orders', {
      token: sign(Math.floor(Date.now() / 1000) - 600),
      tenant: tenantId,
    });
    expect(errorCode(read.body)).not.toBe('STEP_UP_REQUIRED');

    const fresh = await api('POST', '/t/payments/orders', {
      token: sign(Math.floor(Date.now() / 1000) - 10),
      tenant: tenantId,
      body: order,
    });
    expect(errorCode(fresh.body)).not.toBe('STEP_UP_REQUIRED');
  });

  // --- BN-TASK-029: webhooks scopes ------------------------------------------
  it('refuses /t/webhooks to a key holding only payments:read, and admits webhooks:* keys', async () => {
    const paymentsKey = await api('POST', '/api-keys', {
      token: adminToken,
      tenant: tenantId,
      body: { name: 'payments-only', scopes: ['payments:read'] },
    });
    expect(paymentsKey.status).toBe(201);
    const secret = paymentsKey.body['secret'] as string;
    const create = await api('POST', '/t/webhooks', {
      token: secret,
      tenant: tenantId,
      body: { url: 'https://hooks.example.com/x', events: ['payment.paid'] },
    });
    expect(create.status).toBe(403);
    expect(errorCode(create.body)).toBe('MISSING_SCOPE');
    expect((await api('GET', '/t/webhooks', { token: secret, tenant: tenantId })).status).toBe(403);

    const webhooksKey = await api('POST', '/api-keys', {
      token: adminToken,
      tenant: tenantId,
      body: { name: 'webhooks-reader', scopes: ['webhooks:read'] },
    });
    expect(webhooksKey.status).toBe(201);
    expect(
      (await api('GET', '/t/webhooks', { token: webhooksKey.body['secret'] as string, tenant: tenantId }))
        .status,
    ).toBe(200);
  });

  // --- BN-TASK-031: API-key members, invitation, VIEWER -----------------------
  it('caps API-key member creation at MEMBER, refuses a password and invites instead', async () => {
    const key = await api('POST', '/api-keys', {
      token: adminToken,
      tenant: tenantId,
      body: { name: 'users-writer', scopes: ['users:write'] },
    });
    const secret = key.body['secret'] as string;
    const email = `invited-${RUN_ID}@example.test`;

    const admin = await api('POST', '/t/users', {
      token: secret,
      tenant: tenantId,
      body: { email, displayName: 'Would Be Admin', role: 'ADMIN' },
    });
    expect(admin.status).toBe(403);

    const withPassword = await api('POST', '/t/users', {
      token: secret,
      tenant: tenantId,
      body: { email, displayName: 'Invited', password: 'Caller-Chosen-1', role: 'MEMBER' },
    });
    expect(withPassword.status).toBe(422);

    const invited = await api('POST', '/t/users', {
      token: secret,
      tenant: tenantId,
      body: { email, displayName: 'Invited', role: 'MEMBER' },
    });
    expect(invited.status).toBe(201);
    expect(invited.body['status']).toBe('INVITED');
    const invitation = invited.body['invitationToken'] as string;
    expect(typeof invitation).toBe('string');

    const accept = await api('POST', '/t/auth/accept-invitation', {
      tenant: tenantId,
      body: { token: invitation, password: 'Member-Chosen-Pass-1' },
    });
    expect(accept.status).toBe(204);
    const again = await api('POST', '/t/auth/accept-invitation', {
      tenant: tenantId,
      body: { token: invitation, password: 'Member-Chosen-Pass-2' },
    });
    expect(again.status).toBe(400);

    const signIn = await api('POST', '/t/auth/sign-in', {
      tenant: tenantId,
      body: { email, password: 'Member-Chosen-Pass-1' },
    });
    expect(signIn.status).toBe(200);
  });

  it('refuses POST /t/users to a VIEWER (method-level users:write)', async () => {
    const email = `viewer-${RUN_ID}@example.test`;
    const created = await api('POST', '/t/users', {
      token: adminToken,
      tenant: tenantId,
      body: { email, displayName: 'Viewer', password: 'Viewer-Pass-12345', role: 'VIEWER' },
    });
    expect(created.status).toBe(201);
    const signIn = await api('POST', '/t/auth/sign-in', {
      tenant: tenantId,
      body: { email, password: 'Viewer-Pass-12345' },
    });
    const viewerToken = signIn.body['accessToken'] as string;
    expect((await api('GET', '/t/users', { token: viewerToken, tenant: tenantId })).status).toBe(200);
    const attempt = await api('POST', '/t/users', {
      token: viewerToken,
      tenant: tenantId,
      body: { email: `viewer-made-${RUN_ID}@example.test`, displayName: 'Nope', role: 'VIEWER' },
    });
    expect(attempt.status).toBe(403);
  });

  // --- BN-TASK-034: forced password change ----------------------------------
  it('restricts an admin with mustChangePassword to the password change endpoint', async () => {
    await pool.query(`UPDATE "platform_admins" SET "mustChangePassword" = true WHERE "emailLookup" = $1`, [
      crypto.blindIndex(ADMIN_EMAIL),
    ]);
    const blocked = await api('GET', '/tenants', { token: adminToken });
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked.body)).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await api('POST', '/auth/change-password', {
      token: adminToken,
      body: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_ADMIN_PASSWORD },
    });
    expect(changed.status).toBe(200);
    expect(changed.body['mustChangePassword']).toBe(false);
    adminToken = changed.body['accessToken'] as string;
    expect((await api('GET', '/tenants', { token: adminToken })).status).toBe(200);
  });

  // --- BN-TASK-038 / 039: CORS and headers -----------------------------------
  it('answers an allowed preflight with 204 and a disallowed one with 403', async () => {
    const allowed = await api('OPTIONS', '/t/users', {
      headers: { Origin: STAGING_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(STAGING_ORIGIN);

    const evil = await api('OPTIONS', '/t/users', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sends no X-Powered-By header', async () => {
    for (const response of [
      await api('GET', '/health/live', { root: true }),
      await api('GET', '/tenants', { token: adminToken }),
      await api('GET', '/does-not-exist'),
    ]) {
      expect(response.headers.get('x-powered-by')).toBeNull();
    }
  });

  // --- BN-TASK-032: sign-in budget ------------------------------------------
  it('answers 429 on the 11th sign-in within a minute', async () => {
    const statuses: number[] = [];
    while (adminSignIns < 11) {
      statuses.push((await signInAdmin('wrong-password-for-throttle')).status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s !== 429)).toBe(true);
  });
});
