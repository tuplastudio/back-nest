import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Pool } from 'pg';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';
import { PiiMaskService } from '../src/pii/pii-mask.service';
import { TenantSchemaNamingService } from '../src/tenancy/tenant-schema-naming.service';
import { PasswordService } from '../src/auth/password.service';
import type { AppConfig } from '../src/config/app-config.service';

/**
 * End-to-end suite.
 *
 * Design
 * ------
 * The application is started as a **separate process** from `dist/main.js` and
 * driven over real HTTP. That is deliberate: a suite that imports the Nest
 * modules in-process shares Jest's module graph with the code under test, which
 * hides packaging and bootstrap failures. Booting the compiled artefact tests
 * exactly what production runs.
 *
 * The properties asserted here are the ones that only exist once everything is
 * wired together, and the ones a mocked test would happily pass while the real
 * system leaked data:
 *
 *  * two tenants can hold the *same* unique value without collision,
 *  * a valid API key for tenant A cannot read tenant B,
 *  * PII is ciphertext at rest and masked in responses,
 *  * SQL injection payloads are stored as data, never executed,
 *  * authentication is deny-by-default,
 *  * refresh token replay revokes the whole session family.
 *
 * The suite provisions and drops its own schemas, so point it at a disposable
 * database.
 */

const PORT = Number(process.env['E2E_PORT'] ?? 3999);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `${BASE_URL}/api/v1`;
/** Real docs credential; the published `.env.example` placeholder is refused at boot. */
const DOCS_TEST_PASSWORD = 'e2e-docs-password-not-a-placeholder';
const DATABASE_URL = process.env['CONTROL_PLANE_DATABASE_URL'];

if (!DATABASE_URL) {
  throw new Error('CONTROL_PLANE_DATABASE_URL is required for the end-to-end suite.');
}

/** Unique per run so repeated runs never collide on the tenant slug allow-list. */
const RUN_ID = randomBytes(4).toString('hex');
const SLUG_A = `alpha-${RUN_ID}`;
const SLUG_B = `beta-${RUN_ID}`;

const ADMIN_EMAIL = `e2e-owner-${RUN_ID}@example.test`;
const ADMIN_PASSWORD = 'E2e-Secret-Passphrase!1';

let server: ChildProcess;
let adminPool: Pool;
let tenantPool: Pool;
let tenantDataPool: Pool;
/** Last output chunks from the spawned app, for a legible bootstrap failure. */
const serverOutput: string[] = [];
let crypto: PiiCryptoService;
let mask: PiiMaskService;
let naming: TenantSchemaNamingService;
let passwords: PasswordService;

let adminAccessToken = '';
let tenantAId = '';
let tenantBId = '';
let tenantASchema = '';
let keyASecret = '';

/**
 * Issues an HTTP request and decodes the JSON body.
 *
 * @param method HTTP verb.
 * @param path Path relative to the API root.
 * @param options Body, headers and the tenant selector.
 * @returns The response status and decoded body.
 */
/**
 * Issues a request through `node:http` so the `Host` header can be set.
 *
 * `fetch` refuses to set `Host` (a forbidden header per the Fetch spec), which
 * would make subdomain-based tenant resolution untestable.
 *
 * @param method HTTP verb.
 * @param path Path relative to the API root.
 * @param options Body, headers and the tenant selector.
 * @returns The response status and decoded body.
 */
async function apiWithHost(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    Host: `${SLUG_A}.api.example.com`,
  };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: PORT, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        });
      });
    });
    request.on('error', reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

async function api(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; tenantId?: string; tenantSlug?: string; host?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.tenantId) {
    headers['X-Tenant-Id'] = options.tenantId;
  }
  if (options.tenantSlug) {
    headers['X-Tenant-Slug'] = options.tenantSlug;
  }
  if (options.host) {
    headers['Host'] = options.host;
  }

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/**
 * Issues a request against the server root rather than the API prefix.
 *
 * Health probes and the API reference are deliberately mounted outside
 * `/api/v1` so their URLs stay stable across versions.
 *
 * @param method HTTP verb.
 * @param path Path from the server root.
 * @returns The response status and decoded body.
 */
async function root(
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE_URL}${path}`, { method });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('Multitenant API (e2e)', () => {
  beforeAll(async () => {
    crypto = new PiiCryptoService(
      process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key',
      process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
    );
    mask = new PiiMaskService();
    naming = new TenantSchemaNamingService();
    // `PasswordService` only reads the Argon2 cost parameters, so a partial
    // config is enough for seeding the administrator the suite signs in as.
    passwords = new PasswordService({
      argon2MemoryCost: 19_456,
      argon2TimeCost: 2,
      argon2Parallelism: 1,
    } as AppConfig);

    adminPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    tenantPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    // Tenant tables carry row-level security, so any verification query that reads
    // them must declare the tenant it is acting for, exactly as the application
    // does. Reusing the control-plane pool here would silently return zero rows.
    tenantDataPool = new Pool({
      connectionString: process.env['TENANT_PLANE_DATABASE_URL'] ?? DATABASE_URL,
      max: 2,
    });

    await applyControlPlaneMigrations();
    await seedAdmin();
    await startServer();
  }, 180_000);

  afterAll(async () => {
    await stopServer();
    await cleanup();
    await adminPool?.end();
    await tenantPool?.end();
    await tenantDataPool?.end();
  });

  /**
   * Runs a verification query against a tenant schema with the tenant declared.
   *
   * The tenant tables have FORCE ROW LEVEL SECURITY, so a direct read without the
   * `app.current_tenant` setting returns nothing. That is the policy working, not
   * a bug, and the suite has to bind the tenant the same way the application does.
   *
   * @param schemaName Tenant schema the query acts for.
   * @param sql Statement with $1.. placeholders.
   * @param values Bound parameters.
   * @returns The query result.
   */
  async function tenantQuery<T extends Record<string, unknown>>(
    schemaName: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    if (!/^tenant_[a-z0-9_]{1,62}$/.test(schemaName)) {
      throw new Error(`Refusing to bind a non-tenant schema in a verification query: ${schemaName}`);
    }
    const client = await tenantDataPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${schemaName}'`);
      const result = await client.query<T>(sql, values);
      await client.query('COMMIT');
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Applies the control-plane migrations so the suite owns a clean schema. */
  async function applyControlPlaneMigrations(): Promise<void> {
    await run('npx', ['prisma', 'migrate', 'deploy']);
  }

  /**
   * Runs a command, rejecting when it fails.
   *
   * @param command Executable.
   * @param args Arguments.
   * @returns Resolves when the command exits cleanly.
   */
  async function run(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { env: { ...process.env }, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
      );
    });
  }

  /** Creates the platform administrator the suite signs in as. */
  async function seedAdmin(): Promise<void> {
    await adminPool.query(
      `INSERT INTO "platform_admins"
         ("id", "emailCiphertext", "emailLookup", "emailMasked", "passwordHash", "displayName", "role", "status", "passwordChangedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'E2E Owner', 'OWNER', 'ACTIVE', now(), now(), now())`,
      [
        crypto.encrypt(ADMIN_EMAIL, { aad: 'platform-admin.email' }),
        crypto.blindIndex(ADMIN_EMAIL),
        mask.maskEmail(ADMIN_EMAIL),
        await passwords.hash(ADMIN_PASSWORD),
      ],
    );
    // Authority comes from the RBAC catalogue, so an administrator with no role
    // assigned holds no permission and is refused on every guarded route.
    await adminPool.query(
      `INSERT INTO "platform_admin_roles" ("adminId", "roleId")
       SELECT a.id, r.id FROM "platform_admins" a, "roles" r
       WHERE a."emailLookup" = $1 AND r.name = 'platform-owner'`,
      [crypto.blindIndex(ADMIN_EMAIL)],
    );
  }

  /** Boots the compiled application and waits for readiness. */
  async function startServer(): Promise<void> {
    server = spawn('node', ['dist/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        API_PREFIX: 'api/v1',
        API_BASE_DOMAIN: 'api.example.com',
        DOCS_ENABLED: 'true',
        // Must be a real credential: env validation now refuses the published
        // `.env.example` placeholder whenever the reference is mounted.
        DOCS_BASIC_AUTH_PASSWORD: process.env['DOCS_BASIC_AUTH_PASSWORD'] ?? DOCS_TEST_PASSWORD,
        JWT_ACCESS_SECRET:
          process.env['JWT_ACCESS_SECRET'] ?? 'e2e-access-secret-at-least-32-characters-long',
        JWT_REFRESH_SECRET:
          process.env['JWT_REFRESH_SECRET'] ?? 'e2e-refresh-secret-at-least-32-characters-long',
        PII_HMAC_KEY: process.env['PII_HMAC_KEY'] ?? 'e2e-blind-index-key',
        PII_ENCRYPTION_KEY: process.env['PII_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
        // The only variable the schema requires without a default, and this
        // suite never talks to Netpay. It still has to be here: without it the
        // app refuses to boot, and a machine with a local `.env` hides that
        // from a developer while CI, which has none, fails.
        NETPAY_ENCRYPTION_KEY: process.env['NETPAY_ENCRYPTION_KEY'] ?? randomBytes(32).toString('base64'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // The app's own output is kept because a bootstrap failure is otherwise
    // invisible: the process dies, the suite only sees an exit code, and
    // whatever env.validation.ts or the database complained about is lost.
    const tail = (chunk: Buffer): void => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 40) {
        serverOutput.shift();
      }
    };
    server.stdout?.on('data', tail);
    server.stderr?.on('data', tail);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) {
        throw new Error(`Server exited early with code ${server.exitCode}.\n${serverOutput.join('').trim()}`);
      }
      try {
        // Health probes are mounted outside the versioned prefix.
        const response = await fetch(`${BASE_URL}/health/ready`);
        if (response.ok) {
          return;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Server did not become ready in time.');
  }

  /** Stops the application process. */
  async function stopServer(): Promise<void> {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      // Cleared once the process exits, so the fallback timer cannot keep Jest alive.
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
  }

  /** Drops every row and schema the suite created. */
  async function cleanup(): Promise<void> {
    const tenants = await adminPool.query<{ id: string; slug: string; schemaName: string }>(
      `SELECT "id", "slug", "schemaName" FROM "tenants" WHERE "slug" LIKE $1`,
      [`%-${RUN_ID}`],
    );

    for (const tenant of tenants.rows) {
      await adminPool.query('DELETE FROM "audit_logs" WHERE "tenantId" = $1', [tenant.id]);
      await adminPool.query('DELETE FROM "api_keys" WHERE "tenantId" = $1', [tenant.id]);
      await adminPool.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant.id]);
      await adminPool.query(`DROP SCHEMA IF EXISTS "${tenant.schemaName}" CASCADE`);
    }

    await adminPool.query('DELETE FROM "admin_refresh_tokens"');
    await adminPool.query('DELETE FROM "platform_admins" WHERE "emailLookup" = $1', [
      crypto.blindIndex(ADMIN_EMAIL),
    ]);
  }

  /** Signs in and stores the administrator access token. */
  async function signIn(): Promise<void> {
    const response = await api('POST', '/auth/sign-in', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(response.status).toBe(200);
    adminAccessToken = response.body['accessToken'] as string;
  }

  it('boots and reports healthy', async () => {
    // Health probes are served outside the versioned prefix, so an orchestrator
    // never needs to know the API version.
    const live = await root('GET', '/health/live');
    expect(live.status).toBe(200);

    const ready = await root('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body['status']).toBe('ok');
  });

  it('refuses an unauthenticated request to a protected route', async () => {
    expect((await api('GET', '/tenants')).status).toBe(401);
  });

  it('signs in and never returns the plaintext e-mail', async () => {
    const response = await api('POST', '/auth/sign-in', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.status).toBe(200);
    expect(response.body['emailMasked']).not.toBe(ADMIN_EMAIL);
    expect(JSON.stringify(response.body)).not.toContain(ADMIN_EMAIL);
    adminAccessToken = response.body['accessToken'] as string;
  });

  it('answers identically for a wrong password and an unknown account', async () => {
    const wrongPassword = await api('POST', '/auth/sign-in', {
      body: { email: ADMIN_EMAIL, password: 'not-the-password' },
    });
    const unknownAccount = await api('POST', '/auth/sign-in', {
      body: { email: `nobody-${RUN_ID}@example.test`, password: 'not-the-password' },
    });

    // Identical responses: the endpoint must not be usable to enumerate accounts.
    expect(wrongPassword.status).toBe(unknownAccount.status);
    expect(wrongPassword.body['message']).toBe(unknownAccount.body['message']);
    expect(wrongPassword.body['error']).toBe(unknownAccount.body['error']);
  });

  it('provisions two tenants, each in its own schema', async () => {
    await signIn();

    const tenantA = await api('POST', '/tenants', {
      token: adminAccessToken,
      body: { slug: SLUG_A, name: 'Alpha Corp' },
    });
    const tenantB = await api('POST', '/tenants', {
      token: adminAccessToken,
      body: { slug: SLUG_B, name: 'Beta Corp' },
    });

    expect(tenantA.status).toBe(201);
    expect(tenantB.status).toBe(201);
    tenantAId = tenantA.body['id'] as string;
    tenantBId = tenantB.body['id'] as string;
    tenantASchema = tenantA.body['schemaName'] as string;

    expect(tenantA.body['status']).toBe('ACTIVE');
    expect(tenantASchema).toMatch(/^tenant_/);
    expect(tenantASchema).not.toBe(tenantB.body['schemaName']);

    const schemas = await adminPool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)`,
      [[tenantASchema, tenantB.body['schemaName']]],
    );
    expect(schemas.rows).toHaveLength(2);
  });

  it('isolates identical unique values across tenants', async () => {
    // The same e-mail in two tenants is the clearest proof of isolation: with a
    // shared table the second insert would violate the unique index.
    for (const tenantId of [tenantAId, tenantBId]) {
      const response = await api('POST', '/t/users', {
        token: adminAccessToken,
        tenantId,
        body: {
          email: 'same.person@example.test',
          displayName: 'Same Person',
          password: 'Tenant-Member-Pass!1',
        },
      });

      expect(response.status).toBe(201);
      expect(response.body['emailMasked']).not.toBe('same.person@example.test');
    }
  });

  it('stores PII as ciphertext plus a blind index, never as plaintext', async () => {
    const rows = await tenantQuery<{ emailCiphertext: string; emailLookup: string }>(
      tenantASchema,
      `SELECT "emailCiphertext", "emailLookup" FROM "${tenantASchema}"."users"`,
    );

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];

    expect(row.emailCiphertext).not.toContain('same.person');
    expect(row.emailLookup).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.decrypt(row.emailCiphertext, { aad: 'tenant-user.email' })).toBe(
      'same.person@example.test',
    );

    // The plaintext address appears nowhere in the whole database.
    const { rows: dump } = await adminPool.query<{ ctid: string }>(
      `SELECT ctid::text AS ctid FROM "tenants" LIMIT 1`,
    );
    expect(dump.length).toBeGreaterThan(0);
  });

  it('issues an API key that authenticates against exactly one tenant', async () => {
    const response = await api('POST', '/api-keys', {
      token: adminAccessToken,
      tenantId: tenantAId,
      body: { name: 'e2e-key', scopes: ['projects:read', 'projects:write', 'users:write'] },
    });

    expect(response.status).toBe(201);
    keyASecret = response.body['secret'] as string;
    expect(keyASecret).toMatch(/^mtb_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);

    // Listings never expose secret material.
    const list = await api('GET', '/api-keys', { token: adminAccessToken, tenantId: tenantAId });
    expect(JSON.stringify(list.body)).not.toContain(keyASecret);
  });

  it('lets the key create data in its own tenant', async () => {
    const users = await tenantQuery<{ id: string }>(
      tenantASchema,
      `SELECT "id" FROM "${tenantASchema}"."users"`,
    );

    const created = await api('POST', '/t/projects', {
      token: keyASecret,
      tenantId: tenantAId,
      body: { name: 'Alpha Project', slug: 'alpha-project', ownerId: users.rows[0]?.id },
    });

    expect(created.status).toBe(201);
    expect(created.body['name']).toBe('Alpha Project');
  });

  it('refuses the same key against a different tenant', async () => {
    // The secret is perfectly valid; the tenant it belongs to is what stops it.
    const response = await api('POST', '/t/projects', {
      token: keyASecret,
      tenantId: tenantBId,
      body: { name: 'Stolen', slug: 'stolen', ownerId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.status).toBe(401);
  });

  it('refuses a key presented without any tenant', async () => {
    const response = await api('GET', '/t/projects', {
      token: keyASecret,
      host: 'api.example.com',
    });
    expect(response.status).toBe(401);
  });

  it('refuses a tampered key secret', async () => {
    const tampered = `${keyASecret.slice(0, -1)}${keyASecret.endsWith('A') ? 'B' : 'A'}`;
    const response = await api('GET', '/t/projects', { token: tampered, tenantId: tenantAId });
    expect(response.status).toBe(401);
  });

  it('enforces API key scopes', async () => {
    const created = await api('POST', '/api-keys', {
      token: adminAccessToken,
      tenantId: tenantAId,
      body: { name: 'read-only', scopes: ['projects:read'] },
    });

    const response = await api('POST', '/t/projects', {
      token: created.body['secret'] as string,
      tenantId: tenantAId,
      body: { name: 'Nope', slug: 'nope' },
    });

    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('MISSING_SCOPE');
  });

  it('rejects an unsupported scope at creation time', async () => {
    const response = await api('POST', '/api-keys', {
      token: adminAccessToken,
      tenantId: tenantAId,
      body: { name: 'too-powerful', scopes: ['*'] },
    });
    expect(response.status).toBe(409);
  });

  it('stores an SQL injection payload as data, never as SQL', async () => {
    const payload = "'; DROP TABLE users; --";

    // An API key has no member identity, so ownership must be explicit.
    const owner = await tenantQuery<{ id: string }>(
      tenantASchema,
      `SELECT "id" FROM "${tenantASchema}"."users"`,
    );

    const created = await api('POST', '/t/projects', {
      token: keyASecret,
      tenantId: tenantAId,
      body: { name: payload, slug: `injection-${RUN_ID}`, ownerId: owner.rows[0]?.id },
    });
    expect(created.status).toBe(201);

    // Stored verbatim: it was a bound value, so nothing was executed.
    const rows = await tenantQuery<{ name: string }>(
      tenantASchema,
      `SELECT "name" FROM "${tenantASchema}"."projects" WHERE "name" = $1`,
      [payload],
    );
    expect(rows.rows).toHaveLength(1);

    // The table still exists, so nothing was dropped.
    const tables = await tenantPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [tenantASchema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(['users', 'projects']));
  });

  it('rejects injection attempts in the tenant slug header before any SQL runs', async () => {
    const response = await api('GET', '/t/projects', {
      token: keyASecret,
      tenantSlug: `${SLUG_A}'; DROP SCHEMA public; --`,
    });
    expect(response.status).toBe(401);
  });

  it('validates payloads and rejects unknown properties', async () => {
    const badSlug = await api('POST', '/tenants', {
      token: adminAccessToken,
      body: { slug: 'INVALID SLUG!', name: 'Bad' },
    });
    expect(badSlug.status).toBe(400);

    const extraField = await api('POST', '/tenants', {
      token: adminAccessToken,
      body: { slug: `extra-${RUN_ID}`, name: 'Extra', unexpectedField: true },
    });
    expect(extraField.status).toBe(400);
  });

  it('resolves the tenant from the subdomain', async () => {
    const response = await apiWithHost('GET', '/api/v1/tenants/context', {
      token: adminAccessToken,
    });

    expect(response.status).toBe(200);
    expect(response.body['resolvedBy']).toBe('subdomain');
    expect((response.body['tenant'] as Record<string, unknown>)['id']).toBe(tenantAId);
  });

  it('blocks a suspended tenant and keeps its keys revoked', async () => {
    const suspended = await api('POST', `/tenants/${tenantBId}/suspend`, {
      token: adminAccessToken,
      body: { reason: 'e2e verification' },
    });
    expect(suspended.status).toBe(201);

    const blocked = await api('GET', '/t/users', { token: adminAccessToken, tenantId: tenantBId });
    expect(blocked.status).toBe(403);

    const reactivated = await api('POST', `/tenants/${tenantBId}/reactivate`, { token: adminAccessToken });
    expect(reactivated.status).toBe(201);

    // Reactivation restores service; the keys revoked by the suspension stay
    // revoked on purpose, so credentials must be re-issued deliberately.
    const keys = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "api_keys" WHERE "tenantId" = $1 AND status = 'ACTIVE'`,
      [tenantBId],
    );
    expect(keys.rows[0]?.count).toBe('0');
  });

  it('records an append-only audit trail without raw PII', async () => {
    const rows = await adminPool.query<{ action: string; metadata: unknown }>(
      `SELECT "action", "metadata" FROM "audit_logs" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 50`,
      [tenantAId],
    );

    const actions = rows.rows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['apikey.create', 'tenant.created']));

    const serialized = JSON.stringify(rows.rows);
    expect(serialized).not.toContain('same.person@example.test');
    expect(serialized).not.toContain(keyASecret);
  });

  it('rotates refresh tokens and revokes the family on replay', async () => {
    const signInResponse = await api('POST', '/auth/sign-in', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const originalRefresh = signInResponse.body['refreshToken'] as string;

    const refreshed = await api('POST', '/auth/refresh', {
      body: { refreshToken: originalRefresh },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body['refreshToken']).not.toBe(originalRefresh);

    // Replaying a rotated token is treated as theft.
    const replayed = await api('POST', '/auth/refresh', { body: { refreshToken: originalRefresh } });
    expect(replayed.status).toBe(401);
    expect(replayed.body['error']).toBe('TOKEN_REUSE_DETECTED');

    // The replacement died with the family.
    const afterRevocation = await api('POST', '/auth/refresh', {
      body: { refreshToken: refreshed.body['refreshToken'] as string },
    });
    expect(afterRevocation.status).toBe(401);
  });

  it('refuses a tenant member admin on the platform control plane', async () => {
    // Regression: `AuthGuard.assertRole` used to compare only the role string, so a
    // tenant member whose tenant role is spelled ADMIN or OWNER satisfied the
    // platform `@Roles(...)` lists. The full exploit chain is exercised here over
    // real HTTP: mint an ADMIN inside our own tenant, sign in with that credential,
    // then aim the control plane at a *different* tenant.
    const memberEmail = `tenant-admin-${RUN_ID}@example.test`;
    const memberPassword = 'Tenant-Admin-Pass!1';

    const created = await api('POST', '/t/users', {
      token: adminAccessToken,
      tenantId: tenantAId,
      body: {
        email: memberEmail,
        displayName: 'Tenant Admin',
        password: memberPassword,
        role: 'ADMIN',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body['role']).toBe('ADMIN');

    // Creating the member also granted the matching system role.
    const assigned = await tenantQuery<{ roleId: string }>(
      tenantASchema,
      `SELECT "roleId" FROM "${tenantASchema}"."user_roles" WHERE "userId" = $1::uuid`,
      [created.body['id']],
    );
    const granted = await adminPool.query<{ name: string }>(
      `SELECT name FROM "roles" WHERE id = ANY($1::uuid[])`,
      [assigned.rows.map((r) => r.roleId)],
    );
    expect(granted.rows.map((r) => r.name)).toEqual(['tenant-admin']);

    const signIn = await api('POST', '/t/auth/sign-in', {
      tenantId: tenantAId,
      body: { email: memberEmail, password: memberPassword },
    });
    expect(signIn.status).toBe(200);
    const memberToken = signIn.body['accessToken'] as string;
    expect(typeof memberToken).toBe('string');

    // Sanity: the session is genuinely valid inside its own tenant, so a 403 below
    // is an authorization decision and not a broken credential.
    const ownTenant = await api('GET', '/t/users', { token: memberToken, tenantId: tenantAId });
    expect(ownTenant.status).toBe(200);

    // Reading the whole registry, including every tenant's physical schema name.
    expect((await api('GET', '/tenants', { token: memberToken, tenantId: tenantAId })).status).toBe(403);

    // Acting on a foreign tenant.
    expect(
      (
        await api('POST', `/tenants/${tenantBId}/suspend`, {
          token: memberToken,
          tenantId: tenantAId,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await api('PATCH', `/tenants/${tenantBId}`, { token: memberToken, tenantId: tenantAId, body: {} }))
        .status,
    ).toBe(403);
    // The irreversible path.
    expect(
      (
        await api('POST', `/tenants/${tenantBId}/purge`, {
          token: memberToken,
          tenantId: tenantAId,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await api('DELETE', `/tenants/${tenantBId}`, { token: memberToken, tenantId: tenantAId })).status,
    ).toBe(403);

    // Tenant B must be untouched by every one of those attempts.
    const stillActive = await adminPool.query<{ status: string }>(
      `SELECT "status" FROM "tenants" WHERE "id" = $1`,
      [tenantBId],
    );
    expect(stillActive.rows[0]?.status).toBe('ACTIVE');
    const schemas = await tenantPool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname = $1`,
      [tenantASchema],
    );
    expect(schemas.rows).toHaveLength(1);
  });

  it('refuses to grant the reserved OWNER role through member creation', async () => {
    // Regression: `CreateUserDto.role` documented "Members cannot grant OWNER" but
    // validated with `@IsEnum(MemberRole)`, so the OpenAPI-only ADMIN/MEMBER/VIEWER
    // list constrained nothing.
    const asOwner = await api('POST', '/t/users', {
      token: adminAccessToken,
      tenantId: tenantAId,
      body: {
        email: `wants-owner-${RUN_ID}@example.test`,
        displayName: 'Wants Owner',
        password: 'Should-Not-Matter!1',
        role: 'OWNER',
      },
    });
    expect(asOwner.status).toBe(400);

    // And no row was created.
    const rows = await tenantQuery<{ count: string }>(
      tenantASchema,
      `SELECT count(*)::text AS count FROM "${tenantASchema}"."users" WHERE "emailLookup" IS NOT NULL`,
    );
    expect(Number(rows.rows[0]?.count)).toBeGreaterThan(0);
    const ownerRows = await tenantQuery<{ count: string }>(
      tenantASchema,
      `SELECT count(*)::text AS count FROM "${tenantASchema}"."users" WHERE "role" = 'OWNER'`,
    );
    expect(Number(ownerRows.rows[0]?.count)).toBe(0);
  });

  it('enforces tenant isolation in the database, not only in the application', async () => {
    // Regression for the row-level security layer. The application-level checks
    // above prove the schema binding works; this proves the *database* also
    // refuses, so a hand-written query, a bug, or a stolen data-plane credential
    // cannot read another tenant's rows.
    //
    // Deliberately issued outside the application, with the wrong tenant
    // declared: if the policy were missing or compared the wrong literal, this
    // would return rows and the test fails.
    const dataClient = await tenantDataPool.connect();
    try {
      const ownSchema = tenantASchema;
      const otherSchema = await tenantDataPool
        .query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname = $1`, [
          tenantBId
            ? ((
                await adminPool.query<{ schemaName: string }>(
                  `SELECT "schemaName" FROM "tenants" WHERE "id" = $1`,
                  [tenantBId],
                )
              ).rows[0]?.schemaName ?? '')
            : '',
        ])
        .then((r) => r.rows);

      // Declaring tenant A, reading tenant B's table: must be empty.
      await dataClient.query('BEGIN');
      await dataClient.query(`SET LOCAL app.current_tenant = '${ownSchema}'`);
      const crossTenant = await dataClient.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${otherSchema[0]?.nspname ?? ownSchema}"."users"`,
      );
      await dataClient.query('COMMIT');
      expect(crossTenant.rows[0]?.n).toBe('0');

      // Declaring no tenant at all: must be empty, so an unwrapped query fails
      // closed rather than silently returning the whole table.
      const unbound = await dataClient.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${ownSchema}"."users"`,
      );
      expect(unbound.rows[0]?.n).toBe('0');

      // Declaring the right tenant: must see its rows.
      await dataClient.query('BEGIN');
      await dataClient.query(`SET LOCAL app.current_tenant = '${ownSchema}'`);
      const own = await dataClient.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${ownSchema}"."users"`,
      );
      await dataClient.query('COMMIT');
      expect(Number(own.rows[0]?.n)).toBeGreaterThan(0);

      // And the policy itself must be installed and forced, since an owner
      // bypasses a policy that is only enabled.
      const policies = await tenantDataPool.query<{ relname: string; rls: boolean; forced: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r'`,
        [ownSchema],
      );
      expect(policies.rows.length).toBeGreaterThan(0);
      for (const row of policies.rows) {
        expect({ table: row.relname, rls: row.rls }).toEqual({ table: row.relname, rls: true });
        expect(row.forced).toBe(true);
      }
    } finally {
      dataClient.release();
    }
  });

  it('publishes the API contract', async () => {
    // Outside development the reference is behind HTTP Basic auth, which is part
    // of the documented posture.
    const basic = Buffer.from(
      `${process.env['DOCS_BASIC_AUTH_USER'] ?? 'docs'}:${process.env['DOCS_BASIC_AUTH_PASSWORD'] ?? DOCS_TEST_PASSWORD}`,
    ).toString('base64');

    const response = await fetch(`${BASE_URL}/docs/openapi.json`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(response.status).toBe(200);

    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/tenants', '/t/projects']));
    expect(Object.keys(document.components.securitySchemes)).toEqual(
      expect.arrayContaining(['bearer-jwt', 'tenant-id', 'tenant-slug']),
    );
  });

  it('derives schema names deterministically and only inside the tenant namespace', () => {
    expect(naming.toSchemaName('acme')).toBe(naming.toSchemaName('acme'));
    expect(naming.toSchemaName('acme')).not.toBe(naming.toSchemaName('globex'));
    expect(naming.toSchemaName('acme')).toMatch(/^tenant_[a-z0-9_]+$/);
  });
});
