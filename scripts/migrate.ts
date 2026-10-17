import { Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';

/**
 * Aplica las migraciones del plano de control.
 *
 * Existe como comando independiente del arranque por dos razones:
 *
 *  1. Cloud Run arranca N instancias a la vez tras un cambio de configuración
 *     o un scale-out, y `prisma migrate deploy` no es idempotente bajo
 *     concurrencia. Una migración en el arranque es una carrera.
 *  2. La cadena de migración debe ser la DIRECTA. Neon expone Postgres tras
 *     PgBouncer en `pool_mode=transaction`, que no conserva el estado de
 *     sesión del que dependen las migraciones.
 *
 * El Job que lo invoca pasa `--task-count=1 --parallelism=1 --max-retries=0`:
 * una migración se ejecuta una vez y, si falla, es un fallo visible que
 * requiere intervención humana.
 *
 * @throws {Error} When the URL is missing or points at the pooler.
 */
const logger = new Logger('Migrate');

function main(): void {
  const url = process.env['CONTROL_PLANE_DATABASE_URL_UNPOOLED'];

  if (!url) {
    throw new Error('CONTROL_PLANE_DATABASE_URL_UNPOOLED es obligatoria para migrar.');
  }

  // Fail loudly and legibly instead of half-applying a migration through a
  // pooler that cannot support it.
  if (url.includes('-pooler.')) {
    throw new Error(
      'CONTROL_PLANE_DATABASE_URL_UNPOOLED apunta al pooler de Neon. Las migraciones ' +
        'requieren la conexión directa (hostname sin el sufijo "-pooler").',
    );
  }

  logger.log('Aplicando migraciones del plano de control…');

  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
    env: { ...process.env, CONTROL_PLANE_DATABASE_URL: url },
    stdio: 'inherit',
  });

  logger.log('Migraciones aplicadas.');
}

try {
  main();
} catch (error: unknown) {
  console.error('Fallo de migración:', error);
  process.exit(1);
}
