import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quoteIdentifier } from '../prisma/identifiers';
import { assertTenantSchemaName, renderTenantDdl } from '../prisma/tenant-ddl';

/**
 * Tenant-plane migrations: loading, checksums, the per-schema ledger and the
 * locked apply step.
 *
 * Shared by the provisioner (one schema, at tenant creation or on demand) and
 * by `scripts/migrate-tenants.ts` (every ACTIVE schema, in the release
 * pipeline), so both paths take the same lock, write the same ledger and
 * refuse the same mismatches (BN-REQ-OPS-002).
 *
 * The module is deliberately free of Nest and Prisma: the migrate image runs it
 * with `tsx` and a bare `pg` client.
 */

/** Table, inside every tenant schema, recording the migrations applied to it. */
export const LEDGER_TABLE = 'tenant_schema_migrations';

/** Per-schema, transaction-scoped lock shared by every migration path. */
export const ADVISORY_LOCK_SQL = 'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))';

/** Directory name of a migration: `<version>_<snake_case_name>`. */
const MIGRATION_DIR_PATTERN = /^(\d+)_[a-z0-9_]+$/;

/** A versioned migration applied to every tenant schema. */
export interface TenantMigration {
  /** Monotonic version, parsed from the directory name. */
  readonly version: number;
  /** Directory name, e.g. `0002_tenant_rls`. */
  readonly name: string;
  /** Raw SQL script, before {@link renderTenantDdl}. */
  readonly sql: string;
  /** SHA-256 of the script, hex. See {@link checksumOf}. */
  readonly checksum: string;
}

/** A ledger row as stored. */
export interface LedgerRow {
  readonly version: number;
  readonly checksum: string;
}

/**
 * SHA-256 of a migration script.
 *
 * Line endings are normalised first, so a checkout with `core.autocrlf` does
 * not read as a tampered migration. Every other byte counts: an edited comment
 * is still an edited migration.
 *
 * @param sql Script as read from disk.
 * @returns Lower-case hex digest.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Reads every migration under `baseDir`, ordered by version.
 *
 * Strict on purpose: a directory that does not follow the naming convention,
 * a missing `migration.sql` or two directories with the same version are
 * errors, not warnings. Skipping one would leave every tenant silently behind.
 *
 * @param baseDir Usually `prisma/tenant-migrations`.
 * @returns Migrations ordered by version.
 * @throws {Error} On any malformed entry.
 */
export function loadTenantMigrations(baseDir: string): TenantMigration[] {
  const migrations: TenantMigration[] = [];
  const seen = new Map<number, string>();

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const match = MIGRATION_DIR_PATTERN.exec(entry.name);
    if (!match?.[1]) {
      throw new Error(
        `Tenant migration directory "${entry.name}" must be named <version>_<snake_case_name>.`,
      );
    }
    const version = Number.parseInt(match[1], 10);
    const previous = seen.get(version);
    if (previous) {
      throw new Error(`Tenant migrations "${previous}" and "${entry.name}" share version ${version}.`);
    }
    seen.set(version, entry.name);

    const sql = readFileSync(join(baseDir, entry.name, 'migration.sql'), 'utf8');
    migrations.push({ version, name: entry.name, sql, checksum: checksumOf(sql) });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * DDL that creates the ledger in a tenant schema, if absent.
 *
 * Run before reading the ledger, so schemas provisioned before the ledger
 * existed can be adopted. The same table is also created by the tenant
 * migration `0011_tenant_schema_migrations`, so a schema provisioned from
 * scratch gets it through the normal path.
 *
 * The data-plane role inherits DML on every table in the schema through the
 * default privileges of `0002_tenant_rls`; the ledger is taken back from it,
 * since the application has no business rewriting migration history. Like
 * every tenant table it has FORCE ROW LEVEL SECURITY; its policy admits only
 * the owning role, which is the one that migrates.
 *
 * @param schemaName Validated tenant schema.
 * @returns Script to run in the caller's transaction.
 */
export function ledgerDdl(schemaName: string): string {
  assertTenantSchemaName(schemaName);
  const table = `${quoteIdentifier(schemaName)}.${quoteIdentifier(LEDGER_TABLE)}`;
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  "version" INTEGER NOT NULL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "baseline" BOOLEAN NOT NULL DEFAULT false,
  "appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mtb_app') THEN
    REVOKE ALL ON TABLE ${table} FROM mtb_app;
  END IF;
END $$;
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ledger_owner_only" ON ${table};
CREATE POLICY "ledger_owner_only" ON ${table}
  USING (pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = '${table}'::regclass), 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = '${table}'::regclass), 'MEMBER'));`;
}

/** What has to happen to one schema. */
export interface TenantMigrationPlan {
  /**
   * Migrations the schema already has (per `Tenant.schemaVersion`) but that
   * predate the ledger: recorded with the current checksum, not executed.
   */
  readonly baseline: TenantMigration[];
  /** Migrations to execute, in order. */
  readonly pending: TenantMigration[];
  /** Reasons to refuse; non-empty aborts the run. */
  readonly mismatches: string[];
}

/**
 * Decides what to do with one schema. Pure.
 *
 * A mismatch is any disagreement between the ledger and the files: a recorded
 * checksum that differs from the file (an applied migration was edited), a
 * recorded version with no file (a migration was deleted or renamed), or a
 * pending version lower than one already applied (a migration was inserted
 * under history). Each would mean tenants no longer share one schema, so none
 * is fixed automatically.
 *
 * @param ledger Rows read from the schema's ledger.
 * @param migrations Every migration on disk, ordered.
 * @param schemaVersion `Tenant.schemaVersion`; only used to adopt a schema whose ledger is empty.
 * @returns The plan.
 */
export function planTenantMigrations(
  ledger: readonly LedgerRow[],
  migrations: readonly TenantMigration[],
  schemaVersion: number,
): TenantMigrationPlan {
  const mismatches: string[] = [];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));

  for (const row of ledger) {
    const file = byVersion.get(row.version);
    if (!file) {
      mismatches.push(`version ${row.version} is recorded as applied but has no migration file`);
    } else if (file.checksum !== row.checksum.trim()) {
      mismatches.push(
        `${file.name} was modified after being applied (recorded ${row.checksum.trim()}, file ${file.checksum})`,
      );
    }
  }

  if (ledger.length === 0) {
    return {
      baseline: migrations.filter((m) => m.version <= schemaVersion),
      pending: migrations.filter((m) => m.version > schemaVersion),
      mismatches,
    };
  }

  const applied = new Set(ledger.map((row) => row.version));
  const highest = Math.max(...applied);
  const pending = migrations.filter((m) => !applied.has(m.version));
  for (const migration of pending) {
    if (migration.version < highest) {
      mismatches.push(
        `${migration.name} is older than applied version ${highest}; add a new migration instead of inserting one under history`,
      );
    }
  }
  return { baseline: [], pending, mismatches };
}

/** Raised when the ledger and the files disagree. */
export class TenantMigrationMismatchError extends Error {
  /**
   * @param schemaName Schema whose ledger disagrees.
   * @param mismatches Human-readable reasons.
   */
  constructor(
    readonly schemaName: string,
    readonly mismatches: readonly string[],
  ) {
    super(`Tenant schema "${schemaName}" does not match the migration files: ${mismatches.join('; ')}.`);
    this.name = 'TenantMigrationMismatchError';
  }
}

/**
 * The SQL surface the apply step needs, implemented over `pg` by the script and
 * over a Prisma transaction by the provisioner.
 */
export interface TenantMigrationExecutor {
  /** Runs a parameterised query and returns its rows. */
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs a script (possibly several statements, no parameters). */
  exec(sql: string): Promise<void>;
}

/** Outcome of {@link applyTenantMigrations}. */
export interface TenantMigrationResult {
  readonly schemaName: string;
  /** Versions adopted without execution. */
  readonly baselined: number[];
  /** Versions executed. */
  readonly applied: number[];
  /** Highest version recorded after the call. */
  readonly version: number;
}

/** Callbacks into the control plane's `Tenant.schemaVersion`. */
export interface SchemaVersionStore {
  /** Reads the version; called after the lock is held. `0` for an unregistered schema. */
  read(): Promise<number>;
  /** Writes the version reached; called inside the same transaction. */
  write(version: number): Promise<void>;
}

/**
 * Brings one schema up to date. MUST run inside a transaction the caller owns.
 *
 * 1. `pg_advisory_xact_lock(hashtext(schema))`: concurrent runners for the
 *    same schema (two pipeline runs, or a pipeline and a provisioning request)
 *    serialise here, and the second one finds nothing left to do. The lock is
 *    released by the commit or rollback, so a crash cannot leave it held.
 * 2. Creates the ledger if absent and reads it under the lock.
 * 3. Plans; any mismatch throws {@link TenantMigrationMismatchError}.
 * 4. Records baseline rows, executes pending migrations, records each one.
 *
 * Everything for the schema commits or rolls back as one unit.
 *
 * @param db Executor bound to the caller's transaction.
 * @param schemaName Tenant schema.
 * @param migrations Every migration on disk, ordered.
 * @param versions Access to `Tenant.schemaVersion`.
 * @returns What was done.
 * @throws {TenantMigrationMismatchError} When the ledger disagrees with the files.
 */
export async function applyTenantMigrations(
  db: TenantMigrationExecutor,
  schemaName: string,
  migrations: readonly TenantMigration[],
  versions: SchemaVersionStore,
): Promise<TenantMigrationResult> {
  assertTenantSchemaName(schemaName);
  const schema = quoteIdentifier(schemaName);
  const ledgerTable = `${schema}.${quoteIdentifier(LEDGER_TABLE)}`;

  // In FROM so no `void` column reaches the client: Prisma cannot deserialise one.
  await db.query(ADVISORY_LOCK_SQL, [schemaName]);
  await db.exec(`SET LOCAL search_path TO ${schema}, public`);
  await db.exec(ledgerDdl(schemaName));

  const ledger = await db.query<LedgerRow>(
    `SELECT "version", "checksum" FROM ${ledgerTable} ORDER BY "version"`,
  );
  const plan = planTenantMigrations(ledger, migrations, await versions.read());
  if (plan.mismatches.length > 0) {
    throw new TenantMigrationMismatchError(schemaName, plan.mismatches);
  }

  const record = (migration: TenantMigration, baseline: boolean) =>
    db.query(
      `INSERT INTO ${ledgerTable} ("version", "name", "checksum", "baseline") VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.checksum, baseline],
    );

  for (const migration of plan.baseline) {
    await record(migration, true);
  }
  for (const migration of plan.pending) {
    await db.exec(renderTenantDdl(migration.sql, schemaName));
    await record(migration, false);
  }

  const version = Math.max(
    0,
    ...ledger.map((row) => row.version),
    ...plan.baseline.map((m) => m.version),
    ...plan.pending.map((m) => m.version),
  );
  if (plan.baseline.length > 0 || plan.pending.length > 0) {
    await versions.write(version);
  }

  return {
    schemaName,
    baselined: plan.baseline.map((m) => m.version),
    applied: plan.pending.map((m) => m.version),
    version,
  };
}
