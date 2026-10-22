import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';
import { PiiMaskService } from '../src/pii/pii-mask.service';
import { PasswordService } from '../src/auth/password.service';
import type { AppConfig } from '../src/config/app-config.service';

/**
 * `/health/ready` end to end (BN-TASK-003, BN-TASK-037).
 *
 * Boots the compiled app with outbound deliveries switched off and a build
 * stamp, then checks over HTTP that:
 *
 * - an anonymous probe and a forged bearer token get the verdict only;
 * - a verified platform administrator gets the detail plus version and SHA;
 * - an ACTIVE endpoint with deliveries off turns the verdict into `degraded`
 *   with `outboundDisabled`, once the 5 s cache has expired.
 *
 * Needs a disposable database already migrated and seeded with the RBAC
 * catalogue (`npm run prisma:seed`), as in CI. `HEALTH_E2E_ENTRY` points at the
 * compiled entry (default `dist/main.js`).
 */

const PORT = Number(process.env['HEALTH_E2E_PORT'] ?? 3986);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `${BASE_URL}/api/v1`;
const DATABASE_URL = process.env['CONTROL_PLANE_DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('CONTROL_PLANE_DATABASE_URL is required for the end-to-end suite.');
}

const RUN_ID = randomBytes(4).toString('hex');
const SLUG = `health-${RUN_ID}`;
const ADMIN_EMAIL = `e2e-health-${RUN_ID}@example.test`;
const ADMIN_PASSWORD = 'E2e-Health-Passphrase!1';
const BUILD_VERSION = '9.9.9-e2e';
const BUILD_SHA = 'feedc0de'.repeat(5);
const PII_HMAC_KEY = process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key';
const PII_ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64');

let server: ChildProcess;
let pool: Pool;
const serverOutput: string[] = [];
const crypto = new PiiCryptoService(PII_HMAC_KEY, PII_ENCRYPTION_KEY);
let adminToken = '';
let tenantSchema = '';
let tenantId = '';

async function request(
  method: string,
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const ready = (token?: string) => request('GET', `${BASE_URL}/health/ready`, { token });

describe('Health readiness (e2e)', () => {
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
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'E2E Health', 'OWNER', 'ACTIVE', now(), now(), now())`,
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

    server = spawn('node', [process.env['HEALTH_E2E_ENTRY'] ?? 'dist/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        API_PREFIX: 'api/v1',
        DOCS_ENABLED: 'false',
        JWT_ACCESS_SECRET:
          process.env['JWT_ACCESS_SECRET'] ?? 'e2e-access-secret-at-least-32-characters-long',
        JWT_REFRESH_SECRET:
          process.env['JWT_REFRESH_SECRET'] ?? 'e2e-refresh-secret-at-least-32-characters-long',
        PII_HMAC_KEY,
        PII_ENCRYPTION_KEY,
        NETPAY_ENCRYPTION_KEY: process.env['NETPAY_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
        // Deliveries deliberately off, the way a canary runs.
        OUTBOUND_WEBHOOK_ENABLED: 'false',
        MFA_REQUIRED_FOR_ADMINS: 'false',
        BUILD_VERSION,
        BUILD_SHA,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = (chunk: Buffer): void => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 40) serverOutput.shift();
    };
    server.stdout?.on('data', tail);
    server.stderr?.on('data', tail);

    const deadline = Date.now() + 60_000;
    for (;;) {
      if (server.exitCode !== null) {
        throw new Error(`Server exited early.\n${serverOutput.join('')}`);
      }
      try {
        if ((await fetch(`${BASE_URL}/health/live`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`Server did not start.\n${serverOutput.join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const signIn = await request('POST', `${API}/auth/sign-in`, {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(signIn.status).toBe(200);
    adminToken = signIn.body['accessToken'] as string;
  });

  afterAll(async () => {
    if (server !== undefined && server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
    if (tenantId !== '') {
      await pool.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [tenantId]);
      await pool.query('DELETE FROM "tenants" WHERE "id" = $1', [tenantId]);
      await pool.query(`DROP SCHEMA IF EXISTS "${tenantSchema}" CASCADE`);
    }
    await pool.query('DELETE FROM "platform_admins" WHERE "emailLookup" = $1', [
      crypto.blindIndex(ADMIN_EMAIL),
    ]);
    await pool.end();
  });

  it('gives an anonymous probe the verdict and nothing else', async () => {
    const response = await ready();
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['status', 'timestamp']);
  });

  it('gives a forged bearer token the verdict and nothing else', async () => {
    // Well formed, plausible claims, wrong key: the header alone proves nothing.
    const forged = new JwtService().sign(
      { sub: randomUUID(), kind: 'platform-admin' },
      { secret: 'not-the-server-secret-but-long-enough-to-sign', expiresIn: 300 },
    );
    const response = await ready(forged);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['status', 'timestamp']);
  });

  it('gives a verified administrator the detail, with the build version and SHA', async () => {
    const response = await ready(adminToken);
    expect(response.status).toBe(200);
    expect(response.body['build']).toEqual({ version: BUILD_VERSION, sha: BUILD_SHA });
    expect(response.body['checks']).toHaveProperty('control-plane-db');
  });

  it('reports degraded with outboundDisabled while an ACTIVE endpoint exists', async () => {
    const created = await request('POST', `${API}/tenants`, {
      token: adminToken,
      body: { slug: SLUG, name: 'Health Corp' },
    });
    expect(created.status).toBe(201);
    tenantId = created.body['id'] as string;
    tenantSchema = created.body['schemaName'] as string;
    expect(tenantSchema).toMatch(/^tenant_[a-z0-9_]+$/);
    await pool.query(
      `INSERT INTO "${tenantSchema}"."webhook_endpoints"
         ("id", "tenantId", "url", "secretCiphertext", "events", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, 'https://hooks.example.com/x', 'opaque', ARRAY['payment.paid'], 'ACTIVE', now(), now())`,
      [randomUUID(), tenantId],
    );

    // The readiness result is cached for 5 s.
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const detailed = await ready(adminToken);
    expect(detailed.body['status']).toBe('degraded');
    expect(detailed.body['reasons']).toEqual(['outboundDisabled']);
    expect((detailed.body['checks'] as Record<string, { status: string }>)['outbound-webhooks']?.status).toBe(
      'down',
    );
    // Anonymous callers see the verdict, not the cause.
    const anonymous = await ready();
    expect(anonymous.body).toEqual({ status: 'degraded', timestamp: anonymous.body['timestamp'] });
  });
});
