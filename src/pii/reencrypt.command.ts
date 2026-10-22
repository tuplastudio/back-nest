import { Pool, type PoolClient } from 'pg';
import { validateEnv } from '../config/env.validation';
import { Keyring } from './keyring';
import { reencryptTarget, type ReencryptReport, type ReencryptRow, type ReencryptTarget } from './reencrypt';

/**
 * Re-encryption job (BN-REQ-SEC-007): moves every stored ciphertext onto the
 * current key of its keyring, so a retired key can be removed.
 *
 * ```bash
 * npm run build
 * node dist/pii/reencrypt.command.js --dry-run          # count what would change
 * node dist/pii/reencrypt.command.js --batch=500        # rewrite
 * node dist/pii/reencrypt.command.js --only=netpay      # one keyring only
 * ```
 *
 * Runs with the application's environment (same validation as the server).
 * Connects with the control-plane credential; tenant tables carry FORCE ROW
 * LEVEL SECURITY, so every tenant statement runs in a transaction that binds
 * `app.current_tenant`, exactly as the application does. Updates are
 * compare-and-swap on the old ciphertext and the job is idempotent: re-running
 * it finds nothing left to do. Exit code 1 when any value failed to decrypt.
 */

/** A table column holding ciphertext, and how its AAD is derived. */
interface ColumnSpec {
  readonly table: string;
  readonly column: string;
  readonly keyring: 'pii' | 'netpay';
  /** AAD for a row; `tenantId` is the owning tenant for tenant tables. */
  readonly aad: (row: { id: string }, tenantId: string | null) => string;
}

const CONTROL_PLANE_COLUMNS: readonly ColumnSpec[] = [
  { table: 'platform_admins', column: 'emailCiphertext', keyring: 'pii', aad: () => 'platform-admin.email' },
  {
    table: 'platform_admins',
    column: 'mfaSecretCiphertext',
    keyring: 'pii',
    aad: (row) => `platform-admin.mfa:${row.id}`,
  },
];

const TENANT_COLUMNS: readonly ColumnSpec[] = [
  { table: 'users', column: 'emailCiphertext', keyring: 'pii', aad: () => 'tenant-user.email' },
  { table: 'users', column: 'phoneCiphertext', keyring: 'pii', aad: () => 'tenant-user.phone' },
  {
    table: 'payment_provider_config',
    column: 'secretKeyCiphertext',
    keyring: 'netpay',
    aad: (_row, tenantId) => `netpay:config:${tenantId ?? ''}`,
  },
  {
    table: 'webhook_endpoints',
    column: 'secretCiphertext',
    keyring: 'netpay',
    aad: (row) => `webhook:endpoint:${row.id}`,
  },
  {
    table: 'webhook_endpoints',
    column: 'previousSecretCiphertext',
    keyring: 'netpay',
    aad: (row) => `webhook:endpoint:${row.id}`,
  },
];

/** Tenant schema names are generated, but are still checked before quoting. */
const SCHEMA_PATTERN = /^tenant_[a-z0-9_]{1,62}$/;

/**
 * Builds a target over one column, optionally inside one tenant schema.
 *
 * @param pool Control-plane pool.
 * @param spec Column.
 * @param tenant Tenant schema and id, or `null` for the control plane.
 * @returns The target.
 */
function columnTarget(
  pool: Pool,
  spec: ColumnSpec,
  tenant: { schema: string; id: string } | null,
): ReencryptTarget {
  const relation = tenant ? `"${tenant.schema}"."${spec.table}"` : `"${spec.table}"`;
  const column = `"${spec.column}"`;
  const run = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (tenant) {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant.schema]);
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    name: `${tenant ? `${tenant.schema}.` : ''}${spec.table}.${spec.column}`,
    fetchBatch: (afterId, limit) =>
      run(async (client) => {
        const { rows } = await client.query<{ id: string; value: string }>(
          `SELECT "id"::text AS id, ${column} AS value FROM ${relation}
           WHERE ${column} IS NOT NULL AND ($1::text IS NULL OR "id"::text > $1::text)
           ORDER BY "id"::text LIMIT $2`,
          [afterId, limit],
        );
        return rows.map((row): ReencryptRow => ({
          id: row.id,
          value: row.value,
          aad: spec.aad(row, tenant?.id ?? null),
        }));
      }),
    update: (id, previous, next) =>
      run(async (client) => {
        const result = await client.query(
          `UPDATE ${relation} SET ${column} = $3 WHERE "id"::text = $1 AND ${column} = $2`,
          [id, previous, next],
        );
        return (result.rowCount ?? 0) === 1;
      }),
  };
}

/**
 * Parses `--flag` / `--key=value` arguments.
 *
 * @param argv Process arguments after the script.
 * @returns Options.
 */
function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  batchSize: number;
  only: 'pii' | 'netpay' | null;
} {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const only = get('only');
  if (only !== undefined && only !== 'pii' && only !== 'netpay') {
    throw new Error('--only must be "pii" or "netpay".');
  }
  const batchSize = Number(get('batch') ?? 500);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error('--batch must be an integer between 1 and 10000.');
  }
  return { dryRun: argv.includes('--dry-run'), batchSize, only: only ?? null };
}

/** Entry point. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = validateEnv() as {
    database: { url: string };
    auth: { piiEncryptionKey: string; piiKeysJson: string | null };
    payments: { encryptionKey: string; keysJson: string | null };
  };
  const keyrings = {
    pii: config.auth.piiKeysJson
      ? Keyring.fromJson(config.auth.piiKeysJson, config.auth.piiEncryptionKey)
      : Keyring.single(config.auth.piiEncryptionKey),
    netpay: config.payments.keysJson
      ? Keyring.fromJson(config.payments.keysJson, config.payments.encryptionKey)
      : Keyring.single(config.payments.encryptionKey),
  };

  const pool = new Pool({ connectionString: config.database.url, max: 2 });
  const reports: ReencryptReport[] = [];
  try {
    const wanted = (spec: ColumnSpec): boolean => options.only === null || options.only === spec.keyring;
    for (const spec of CONTROL_PLANE_COLUMNS.filter(wanted)) {
      reports.push(await reencryptTarget(keyrings[spec.keyring], columnTarget(pool, spec, null), options));
    }
    const { rows: tenants } = await pool.query<{ id: string; schemaName: string }>(
      `SELECT t."id"::text AS id, t."schemaName" FROM "tenants" t
       WHERE EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = t."schemaName")
       ORDER BY t."schemaName"`,
    );
    for (const tenant of tenants) {
      if (!SCHEMA_PATTERN.test(tenant.schemaName)) {
        process.stderr.write(`Skipping tenant ${tenant.id}: unexpected schema name.\n`);
        continue;
      }
      for (const spec of TENANT_COLUMNS.filter(wanted)) {
        const target = columnTarget(pool, spec, { schema: tenant.schemaName, id: tenant.id });
        reports.push(await reencryptTarget(keyrings[spec.keyring], target, options));
      }
    }
  } finally {
    await pool.end();
  }

  for (const report of reports) {
    process.stdout.write(`${JSON.stringify({ ...report, dryRun: options.dryRun })}\n`);
  }
  const failed = reports.reduce((sum, r) => sum + r.failed, 0);
  const rewritten = reports.reduce((sum, r) => sum + r.rewritten, 0);
  process.stdout.write(
    `${JSON.stringify({ summary: true, piiCurrent: keyrings.pii.currentVersion, netpayCurrent: keyrings.netpay.currentVersion, rewritten, failed, dryRun: options.dryRun })}\n`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
