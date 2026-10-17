import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * Prisma 7 removed `url` from the `datasource` block of `*.prisma` files. The
 * connection string now lives here for CLI commands (`prisma migrate`,
 * `prisma db push`, `prisma studio`), while the runtime application builds its
 * own connections through a driver adapter — see
 * `src/database/control-plane-prisma.service.ts`.
 *
 * Two schemas are handled:
 *  - `prisma/schema.prisma`        -> control plane (public schema), migrated
 *                                    by the CLI into `public`.
 *  - `prisma/schema.tenant.prisma` -> tenant data plane template. It is
 *                                    rendered to SQL with `prisma migrate
 *                                    diff` and applied per tenant schema at
 *                                    provisioning time (see
 *                                    `src/tenancy/tenant-provisioner.service.ts`).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Direct (unpooled) connection, deliberately NOT the runtime URL.
    //
    // Neon fronts Postgres with PgBouncer in `pool_mode=transaction`, which
    // does not support the session state `prisma migrate` relies on. Migrating
    // through the pooled endpoint fails, or worse, half-applies. The runtime
    // keeps its pooled URL in CONTROL_PLANE_DATABASE_URL; this variable exists
    // solely for the CLI.
    //
    // No fallback to CONTROL_PLANE_DATABASE_URL on purpose: silently migrating
    // through the pooler is the failure mode this indirection exists to prevent.
    // A local .env must set both, and the difference is documented in
    // .env.example.
    url: process.env['CONTROL_PLANE_DATABASE_URL_UNPOOLED'] ?? '',
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  views: {
    path: 'prisma/views',
  },
});
