import { type LoggerService } from '@nestjs/common';
import { Client, type ClientConfig } from 'pg';
import { isValidTenantSchemaName, quoteIdentifier } from '../../src/prisma/identifiers';
import {
  applyTenantMigrations,
  LEDGER_TABLE,
  type LedgerRow,
  loadTenantMigrations,
  planTenantMigrations,
  type TenantMigration,
  type TenantMigrationExecutor,
  TenantMigrationMismatchError,
  type TenantMigrationResult,
} from '../../src/tenancy/tenant-migrations';

/**
 * Applies `prisma/tenant-migrations` to every ACTIVE tenant (BN-REQ-OPS-002).
 *
 * Three phases, each a gate for the next:
 *
 *  1. **Preflight**, read-only: every ACTIVE schema's ledger is compared with
 *     the files. One mismatch anywhere aborts before any schema is touched, so
 *     an edited migration cannot leave half the tenants migrated.
 *  2. **Apply**, one transaction per schema under
 *     `pg_advisory_xact_lock(hashtext(schema))`. A concurrent run (a re-run
 *     pipeline, a provisioning request) waits on the lock and then finds the
 *     work done; the ledger's primary key would reject a double apply anyway.
 *  3. **Verify**: every ACTIVE schema must end at the highest file version with
 *     one ledger row per migration. Anything else fails the Job, which stops
 *     the pipeline before traffic moves.
 */

/** Options for {@link runTenantMigrations}. */
export interface TenantMigrationRunOptions {
  /** Direct (non-pooled) connection string to the control-plane database. */
  readonly connectionString: string;
  /** Directory holding `<version>_<name>/migration.sql`. */
  readonly migrationsDir: string;
  /** Where progress goes. */
  readonly logger: Pick<LoggerService, 'log' | 'warn' | 'error'>;
  /** Extra `pg` client settings, e.g. `application_name`. */
  readonly client?: Omit<ClientConfig, 'connectionString'>;
}

/** Outcome of a run. */
export interface TenantMigrationRunSummary {
  /** Highest migration version on disk. */
  readonly targetVersion: number;
  /** One entry per ACTIVE tenant, in processing order. */
  readonly tenants: TenantMigrationResult[];
}

/** An ACTIVE tenant as read from the control plane. */
interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly schemaName: string;
}

/** Raised when the final verification finds a schema behind. */
export class TenantMigrationVerificationError extends Error {
  /**
   * @param problems One line per schema that is not at the target version.
   */
  constructor(readonly problems: readonly string[]) {
    super(`Tenant schemas are not at the target version: ${problems.join('; ')}.`);
    this.name = 'TenantMigrationVerificationError';
  }
}

/**
 * Runs the three phases. Throws on the first failure; the caller exits non-zero.
 *
 * @param options See {@link TenantMigrationRunOptions}.
 * @returns What was applied, per tenant.
 * @throws {TenantMigrationMismatchError} When a ledger disagrees with the files.
 * @throws {TenantMigrationVerificationError} When a schema is behind after applying.
 */
export async function runTenantMigrations(
  options: TenantMigrationRunOptions,
): Promise<TenantMigrationRunSummary> {
  const { logger } = options;
  const migrations = loadTenantMigrations(options.migrationsDir);
  const targetVersion = migrations.at(-1)?.version ?? 0;
  if (migrations.length === 0) {
    logger.warn('No tenant migrations on disk; nothing to do.');
    return { targetVersion, tenants: [] };
  }

  const client = new Client({ ...options.client, connectionString: options.connectionString });
  await client.connect();
  try {
    const tenants = await activeTenants(client);
    logger.log({
      event: 'tenant_migrations_start',
      message: `Tenant migrations: ${tenants.length} ACTIVE tenant(s), target version ${targetVersion}.`,
      tenants: tenants.length,
      targetVersion,
    });

    await preflight(client, tenants, migrations);

    const results: TenantMigrationResult[] = [];
    for (const tenant of tenants) {
      const result = await migrateOne(client, tenant, migrations);
      results.push(result);
      logger.log({
        event: 'tenant_migrated',
        message: `${tenant.schemaName}: applied [${result.applied.join(', ')}], baselined [${result.baselined.join(', ')}], at ${result.version}.`,
        tenantId: tenant.id,
        schemaName: tenant.schemaName,
        applied: result.applied,
        baselined: result.baselined,
        version: result.version,
      });
    }

    await verify(client, migrations);
    logger.log({
      event: 'tenant_migrations_verified',
      message: `All ${tenants.length} ACTIVE tenant schema(s) at version ${targetVersion}.`,
      targetVersion,
    });
    return { targetVersion, tenants: results };
  } finally {
    await client.end();
  }
}

/**
 * Lists ACTIVE, non-deleted tenants, rejecting any stored schema name outside
 * the `tenant_` namespace before it can reach DDL.
 */
async function activeTenants(client: Client): Promise<TenantRow[]> {
  const { rows } = await client.query<TenantRow>(
    `SELECT "id", "slug", "schemaName" FROM "tenants"
      WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL
      ORDER BY "createdAt", "id"`,
  );
  const invalid = rows.filter((row) => !isValidTenantSchemaName(row.schemaName));
  if (invalid.length > 0) {
    throw new Error(
      `Refusing to migrate tenants with a schema outside the tenant_ namespace: ${invalid.map((t) => t.id).join(', ')}.`,
    );
  }
  return rows;
}

/** Phase 1: compares every ledger with the files without writing anything. */
async function preflight(
  client: Client,
  tenants: readonly TenantRow[],
  migrations: readonly TenantMigration[],
): Promise<void> {
  const failures: TenantMigrationMismatchError[] = [];
  for (const tenant of tenants) {
    const ledger = await readLedgerIfPresent(client, tenant.schemaName);
    // An absent or empty ledger is adopted in phase 2 from `schemaVersion`;
    // there is nothing to compare yet.
    const plan = planTenantMigrations(ledger, migrations, 0);
    if (ledger.length > 0 && plan.mismatches.length > 0) {
      failures.push(new TenantMigrationMismatchError(tenant.schemaName, plan.mismatches));
    }
  }
  if (failures.length === 1 && failures[0]) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new TenantMigrationMismatchError(
      failures.map((f) => f.schemaName).join(', '),
      failures.flatMap((f) => f.mismatches.map((m) => `${f.schemaName}: ${m}`)),
    );
  }
}

/** Phase 2 for one tenant: its own transaction, under its own advisory lock. */
async function migrateOne(
  client: Client,
  tenant: TenantRow,
  migrations: readonly TenantMigration[],
): Promise<TenantMigrationResult> {
  const db: TenantMigrationExecutor = {
    query: async <T>(sql: string, params: readonly unknown[] = []) =>
      (await client.query(sql, [...params])).rows as T[],
    exec: async (sql: string) => {
      await client.query(sql);
    },
  };

  await client.query('BEGIN');
  try {
    const result = await applyTenantMigrations(db, tenant.schemaName, migrations, {
      read: async () => {
        const { rows } = await client.query<{ schemaVersion: number }>(
          'SELECT "schemaVersion" FROM "tenants" WHERE "id" = $1',
          [tenant.id],
        );
        return rows[0]?.schemaVersion ?? 0;
      },
      write: async (version) => {
        await client.query('UPDATE "tenants" SET "schemaVersion" = $2, "updatedAt" = now() WHERE "id" = $1', [
          tenant.id,
          version,
        ]);
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Phase 3: every ACTIVE schema at the target, one ledger row per file. */
async function verify(client: Client, migrations: readonly TenantMigration[]): Promise<void> {
  const target = migrations.at(-1)?.version ?? 0;
  const problems: string[] = [];
  const { rows } = await client.query<TenantRow & { schemaVersion: number }>(
    `SELECT "id", "slug", "schemaName", "schemaVersion" FROM "tenants"
      WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL`,
  );
  for (const tenant of rows) {
    const ledger = await readLedgerIfPresent(client, tenant.schemaName);
    const plan = planTenantMigrations(ledger, migrations, 0);
    const recorded = Math.max(0, ...ledger.map((row) => row.version));
    if (
      tenant.schemaVersion !== target ||
      recorded !== target ||
      plan.pending.length > 0 ||
      plan.mismatches.length > 0
    ) {
      problems.push(
        `${tenant.schemaName} schemaVersion=${tenant.schemaVersion} ledger=${recorded} missing=[${plan.pending
          .map((m) => m.version)
          .join(', ')}]`,
      );
    }
  }
  if (problems.length > 0) {
    throw new TenantMigrationVerificationError(problems);
  }
}

/** Reads a schema's ledger; empty when the schema predates it. */
async function readLedgerIfPresent(client: Client, schemaName: string): Promise<LedgerRow[]> {
  const table = `${quoteIdentifier(schemaName)}.${quoteIdentifier(LEDGER_TABLE)}`;
  const { rows: exists } = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [table],
  );
  if (!exists[0]?.present) {
    return [];
  }
  const { rows } = await client.query<LedgerRow>(
    `SELECT "version", "checksum" FROM ${table} ORDER BY "version"`,
  );
  return rows;
}
