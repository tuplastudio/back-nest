import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { TenantMigrationMismatchError } from '../../src/tenancy/tenant-migrations';
import { runTenantMigrations } from './tenant-migration-runner';

/**
 * Integration test for BN-TASK-042 against a real PostgreSQL.
 *
 * Needs a disposable server; locally:
 *   docker run -d --name bn-e2e-c2 -p 127.0.0.1:55436:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
 * and `npm run test:int`. CI points TENANT_MIGRATIONS_TEST_DATABASE_URL at its
 * service container. Each run creates and drops its own database.
 */
const ADMIN_URL =
  process.env['TENANT_MIGRATIONS_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:55436/postgres';
const ROOT = process.cwd();
const ALL_MIGRATIONS = join(ROOT, 'prisma', 'tenant-migrations');

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Copies the first `count` migrations (or all) into a temp dir, so a "release" can be simulated. */
function migrationsDir(count?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-migrations-'));
  const names = readdirSync(ALL_MIGRATIONS).sort();
  for (const name of names.slice(0, count ?? names.length)) {
    cpSync(join(ALL_MIGRATIONS, name), join(dir, name), { recursive: true });
  }
  return dir;
}

describe('migrate-tenants (BN-TASK-042, integration)', () => {
  const database = `bn_tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const url = urlFor(database);
  const total = readdirSync(ALL_MIGRATIONS).length;
  const latest = Number.parseInt(readdirSync(ALL_MIGRATIONS).sort().at(-1) ?? '0', 10);
  const dirs: string[] = [];
  const tenants = ['tenant_alpha', 'tenant_bravo', 'tenant_charlie'];

  const run = (dir: string) =>
    runTenantMigrations({ connectionString: url, migrationsDir: dir, logger: silent });
  const tmp = (count?: number) => {
    const dir = migrationsDir(count);
    dirs.push(dir);
    return dir;
  };

  async function addTenant(client: Client, schemaName: string, status = 'ACTIVE'): Promise<void> {
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(
      `INSERT INTO "tenants" ("id", "slug", "name", "schemaName", "status", "updatedAt")
       VALUES ($1, $2, $2, $3, $4::"TenantStatus", now())`,
      [randomUUID(), schemaName.replace('tenant_', ''), schemaName, status],
    );
  }

  async function state(client: Client, schemaName: string) {
    const { rows: tenant } = await client.query<{ schemaVersion: number }>(
      'SELECT "schemaVersion" FROM "tenants" WHERE "schemaName" = $1',
      [schemaName],
    );
    const { rows: ledger } = await client.query<{ version: number; baseline: boolean }>(
      `SELECT "version", "baseline" FROM "${schemaName}"."tenant_schema_migrations" ORDER BY "version"`,
    );
    return { schemaVersion: tenant[0]?.schemaVersion, ledger };
  }

  beforeAll(async () => {
    await withClient(ADMIN_URL, async (admin) => {
      await admin.query(`CREATE DATABASE "${database}"`);
      for (const role of ['mtb_control', 'mtb_app']) {
        await admin.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
        );
      }
    });
    // The real control-plane schema, so the runner reads the real `tenants` table.
    await withClient(url, async (client) => {
      const root = join(ROOT, 'prisma', 'migrations');
      for (const name of readdirSync(root)
        .filter((n) => /^\d{14}_/.test(n))
        .sort()) {
        await client.query(readFileSync(join(root, name, 'migration.sql'), 'utf8'));
      }
      for (const schema of tenants) {
        await addTenant(client, schema);
      }
      await addTenant(client, 'tenant_dormant', 'SUSPENDED');
    });
  });

  afterAll(async () => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    await withClient(ADMIN_URL, (admin) => admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
  });

  it('brings 3 ACTIVE tenants from the previous release to the new version before traffic', async () => {
    const previousRelease = tmp(total - 1);
    const first = await run(previousRelease);
    expect(first.tenants.map((t) => t.schemaName)).toEqual(tenants);

    const release = await run(tmp());
    expect(release.targetVersion).toBe(latest);
    for (const result of release.tenants) {
      expect(result.applied).toEqual([latest]);
    }

    await withClient(url, async (client) => {
      for (const schema of tenants) {
        const { schemaVersion, ledger } = await state(client, schema);
        expect(schemaVersion).toBe(latest);
        expect(ledger).toHaveLength(total);
      }
      // Not ACTIVE, so not touched.
      const { rows } = await client.query(`SELECT to_regclass('"tenant_dormant"."users"') AS t`);
      expect(rows[0]).toEqual({ t: null });
    });
  });

  it('a second run is a no-op', async () => {
    const again = await run(tmp());
    expect(again.tenants.every((t) => t.applied.length === 0 && t.baselined.length === 0)).toBe(true);
  });

  it('concurrent runs apply a new migration exactly once per tenant', async () => {
    const dir = tmp();
    const probe = join(dir, '9000_concurrency_probe');
    mkdirSync(probe);
    // Not idempotent on purpose: a second execution in the same schema would add a second row.
    writeFileSync(
      join(probe, 'migration.sql'),
      'CREATE TABLE IF NOT EXISTS "probe" ("n" INTEGER);\nINSERT INTO "probe" VALUES (1);\nSELECT pg_sleep(0.2);\n',
    );

    const results = await Promise.all([run(dir), run(dir), run(dir)]);
    const appliedCount = results.flatMap((r) => r.tenants).filter((t) => t.applied.includes(9000)).length;
    expect(appliedCount).toBe(tenants.length);

    await withClient(url, async (client) => {
      for (const schema of tenants) {
        const { rows } = await client.query<{ count: string }>(`SELECT count(*) FROM "${schema}"."probe"`);
        expect(rows[0]?.count).toBe('1');
        expect((await state(client, schema)).schemaVersion).toBe(9000);
      }
    });
  });

  it('aborts on an altered checksum before touching any tenant', async () => {
    const dir = tmp();
    // The probe from the previous test stays on disk, so history matches...
    const probe = join(dir, '9000_concurrency_probe');
    mkdirSync(probe);
    writeFileSync(
      join(probe, 'migration.sql'),
      'CREATE TABLE IF NOT EXISTS "probe" ("n" INTEGER);\nINSERT INTO "probe" VALUES (1);\nSELECT pg_sleep(0.2);\n',
    );
    // ...plus a new pending migration that must NOT be applied anywhere...
    const pending = join(dir, '9001_should_not_run');
    mkdirSync(pending);
    writeFileSync(join(pending, 'migration.sql'), 'CREATE TABLE "should_not_exist" ("n" INTEGER);\n');
    // ...and one applied migration edited after the fact.
    const edited = readdirSync(dir).sort()[0] ?? '';
    appendFileSync(join(dir, edited, 'migration.sql'), '\n-- edited after release\n');

    await expect(run(dir)).rejects.toBeInstanceOf(TenantMigrationMismatchError);
    await expect(run(dir)).rejects.toThrow(/was modified after being applied/);

    await withClient(url, async (client) => {
      for (const schema of tenants) {
        const { rows } = await client.query(`SELECT to_regclass('"${schema}"."should_not_exist"') AS t`);
        expect(rows[0]).toEqual({ t: null });
        expect((await state(client, schema)).schemaVersion).toBe(9000);
      }
    });
  });

  it('adopts a schema provisioned before the ledger existed without re-running its migrations', async () => {
    await withClient(url, async (client) => {
      await addTenant(client, 'tenant_legacy');
      // What the old provisioner left behind: the tables, schemaVersion, no ledger.
      const dir = tmp(total - 1);
      for (const name of readdirSync(dir).sort()) {
        const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8')
          .replace(/__TENANT_SCHEMA_LITERAL__/g, `'tenant_legacy'`)
          .replace(/__TENANT_SCHEMA__/g, '"tenant_legacy"')
          .replace(/CREATE TYPE\s+("[^"]+")\s+AS\s+ENUM/gi, 'CREATE TYPE "tenant_legacy".$1 AS ENUM');
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO "tenant_legacy", public');
        await client.query(sql);
        await client.query('COMMIT');
      }
      await client.query(`DROP TABLE IF EXISTS "tenant_legacy"."tenant_schema_migrations"`);
      await client.query(`UPDATE "tenants" SET "schemaVersion" = $1 WHERE "schemaName" = 'tenant_legacy'`, [
        Number.parseInt(readdirSync(dir).sort().at(-1) ?? '0', 10),
      ]);
    });

    // Only the real migrations, so the earlier probe is not part of this release.
    await withClient(url, async (client) => {
      for (const schema of tenants) {
        await client.query(`DELETE FROM "${schema}"."tenant_schema_migrations" WHERE "version" = 9000`);
      }
    });
    await withClient(url, (client) =>
      client.query(`UPDATE "tenants" SET "schemaVersion" = $1 WHERE "schemaName" = ANY($2)`, [
        latest,
        tenants,
      ]),
    );

    const summary = await run(tmp());
    const legacy = summary.tenants.find((t) => t.schemaName === 'tenant_legacy');
    expect(legacy?.baselined).toHaveLength(total - 1);
    expect(legacy?.applied).toEqual([latest]);

    await withClient(url, async (client) => {
      const { schemaVersion, ledger } = await state(client, 'tenant_legacy');
      expect(schemaVersion).toBe(latest);
      expect(ledger.filter((r) => r.baseline)).toHaveLength(total - 1);
      // The data-plane role cannot rewrite migration history.
      const { rows } = await client.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('mtb_app', '"tenant_legacy"."tenant_schema_migrations"', 'INSERT') AS allowed`,
      );
      expect(rows[0]?.allowed).toBe(false);
    });
  });
});
