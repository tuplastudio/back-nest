import { join } from 'node:path';
import { JsonLogger, LOG_LEVELS, type ConfiguredLogLevel } from '../src/common/logging/json-logger';
import { runTenantMigrations } from './lib/tenant-migration-runner';

/**
 * Aplica `prisma/tenant-migrations` a todo tenant ACTIVE (BN-REQ-OPS-002).
 *
 * Corre en el Cloud Run Job de migraciones, después de `scripts/migrate.ts`
 * (plano de control) y antes de que el pipeline despliegue código: un release
 * que trae una migración de tenant no recibe tráfico hasta que todos los
 * esquemas ACTIVE la tienen.
 *
 * Por esquema: `pg_advisory_xact_lock(hashtext(schema))`, una transacción,
 * y el ledger `tenant_schema_migrations` con `(version, sha256)`. Si un
 * checksum registrado no coincide con el fichero, aborta antes de tocar ningún
 * esquema. Al final verifica que todos estén en la versión máxima.
 *
 * Usa la conexión DIRECTA por la misma razón que `scripts/migrate.ts`: el
 * pooler de Neon en modo transacción no es sitio para DDL.
 *
 * @throws {Error} Cuando falta la URL o apunta al pooler; el proceso sale con 1.
 */
async function main(): Promise<void> {
  const level = (process.env['LOG_LEVEL'] ?? 'log') as ConfiguredLogLevel;
  const logger = new JsonLogger({ level: LOG_LEVELS.includes(level) ? level : 'log' });
  const url = process.env['CONTROL_PLANE_DATABASE_URL_UNPOOLED'];

  if (!url) {
    throw new Error('CONTROL_PLANE_DATABASE_URL_UNPOOLED es obligatoria para migrar tenants.');
  }
  if (url.includes('-pooler.')) {
    throw new Error(
      'CONTROL_PLANE_DATABASE_URL_UNPOOLED apunta al pooler de Neon. Las migraciones de tenant ' +
        'requieren la conexión directa (hostname sin el sufijo "-pooler").',
    );
  }

  await runTenantMigrations({
    connectionString: url,
    migrationsDir: process.env['TENANT_MIGRATIONS_DIR'] ?? join(process.cwd(), 'prisma', 'tenant-migrations'),
    logger,
    client: { application_name: 'netpay-migrate-tenants' },
  });
}

main().catch((error: unknown) => {
  new JsonLogger({ level: 'error' }).fatal(
    error instanceof Error ? error : String(error),
    'Fallo de migración de tenants',
  );
  process.exit(1);
});
