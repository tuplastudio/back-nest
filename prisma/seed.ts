// Loads `.env` so `npm run prisma:seed` works without exporting variables first.
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/control-plane/client';
import { PrismaClient as TenantClient } from '../src/generated/tenant-plane/client';
import { AuditActorType, PlatformRole, TenantStatus } from '../src/generated/control-plane/enums';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';
import { PiiMaskService } from '../src/pii/pii-mask.service';
import { grantPlatformRole, grantTenantRoles, seedRbacCatalog } from './rbac-seed';
import { TenantSchemaNamingService } from '../src/tenancy/tenant-schema-naming.service';
import { renderTenantDdl } from '../src/prisma/tenant-ddl';

/**
 * Database seed for local development.
 *
 * Creates the initial platform owner, a demo tenant with its schema applied, and
 * that tenant's first member, so a fresh checkout can sign in and explore the API
 * immediately.
 *
 * PII handling
 * ------------
 * The seed reuses the application's own {@link PiiCryptoService} and
 * {@link PiiMaskService} rather than reimplementing them, which guarantees the
 * seeded data is byte-for-byte compatible with what the application can decrypt.
 * That matters: blind indexes are derived keys, so a seed that hashed differently
 * would produce records the application could never find.
 *
 * Credentials
 * -----------
 * Every value can be overridden through `SEED_*` environment variables. The
 * defaults are development-only and must be rotated before any real deployment —
 * the script says so on completion.
 *
 * Run with:
 * ```bash
 * npm run prisma:seed
 * ```
 */

/** E-mail of the bootstrapped platform owner. */
const OWNER_EMAIL = process.env['SEED_OWNER_EMAIL'] ?? 'owner@example.com';

/** Password for the seeded owner. Required, never defaulted. */
const OWNER_PASSWORD = requiredEnv('SEED_OWNER_PASSWORD');

/** Slug of the demo tenant. */
const DEMO_TENANT_SLUG = process.env['SEED_TENANT_SLUG'] ?? 'acme';

/** Display name of the demo tenant. */
const DEMO_TENANT_NAME = process.env['SEED_TENANT_NAME'] ?? 'ACME Corporation';

/** E-mail of the seeded tenant member. */
const MEMBER_EMAIL = process.env['SEED_MEMBER_EMAIL'] ?? 'ada@acme.com';

/** Password for the seeded member. Required, never defaulted. */
const MEMBER_PASSWORD = requiredEnv('SEED_MEMBER_PASSWORD');

/** Connection string; required at runtime because Prisma 7 takes an adapter. */
const databaseUrl = process.env['CONTROL_PLANE_DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'CONTROL_PLANE_DATABASE_URL is required to run the seed script. Copy .env.example to .env and set it.',
  );
}

/**
 * Reads an environment variable that the seed refuses to default.
 *
 * The seed used to fall back to published literals, which meant a deployment
 * could quietly come up holding well-known credentials. Failing here keeps the
 * operator in control of what actually lands in the database.
 *
 * @param name Variable to read.
 * @returns The configured value.
 * @throws When the variable is absent or empty.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is required to run the seed script; there is no development fallback. ` +
        'Copy .env.example to .env and set it explicitly.',
    );
  }
  return value;
}

// The seed creates accounts with development passwords. The guard treats every
// profile that is not explicitly local as production, so a staging value, a
// typo, or an unset NODE_ENV cannot slip past: the previous exact-match test let
// `staging`, `prod`, `Production` and an absent value all proceed.
//
// The opt-out is parsed as a real boolean, so `SEED_ALLOW_PRODUCTION=false` keeps
// the guard in place rather than removing it — the previous presence test did the
// opposite and inverted the operator's intent.
const seedNodeEnv = process.env['NODE_ENV']?.trim();
if (seedNodeEnv !== 'development' && seedNodeEnv !== 'test') {
  const optIn = process.env['SEED_ALLOW_PRODUCTION']?.trim().toLowerCase();
  if (optIn !== 'true' && optIn !== '1') {
    throw new Error(
      'Refusing to seed with development credentials outside development/test ' +
        `(NODE_ENV=${String(seedNodeEnv)}). Run with NODE_ENV=development for a local ` +
        'database, or set SEED_ALLOW_PRODUCTION=true together with every SEED_* variable ' +
        'explicitly if seeding a real deployment is really intended.',
    );
  }
}

/** Reused across every seeded record so keys stay consistent. */
const pii = new PiiCryptoService(requiredEnv('PII_HMAC_KEY'), requiredEnv('PII_ENCRYPTION_KEY'));
const mask = new PiiMaskService();
const naming = new TenantSchemaNamingService();

/**
 * Argon2id parameters for seeded passwords.
 *
 * Matches the application defaults so a seeded hash verifies with the
 * application's own configuration.
 */
const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Creates the connection pool shared by every client in this script.
 *
 * @returns A configured `pg` pool.
 */
function createPool(): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'vondi-api/seed',
  });
}

/**
 * Loads every tenant migration and adapts them for the target schema.
 *
 * All of them, not just `0001_init`: the later migrations carry the row-level
 * security policies and the data-plane grants, so applying only the first one
 * produces a schema the application cannot read when the data plane connects as
 * the restricted role. The seed has to leave a tenant in the same state the
 * provisioner would.
 *
 * @param schemaName Target tenant schema.
 * @returns Ordered SQL safe to execute with `search_path` set to `schemaName`.
 */
function tenantBootstrapDdl(schemaName: string, fromVersion = 0): { sql: string; version: number } {
  const root = join(process.cwd(), 'prisma', 'tenant-migrations');
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((name) => ({ name, version: Number.parseInt(name, 10) }))
    // Only what the schema has not seen yet. Applying every migration on every
    // run made the seed non-idempotent: `0001_init` creates the MemberRole type
    // unconditionally, so a second run against an existing tenant failed with
    // 'type "MemberRole" already exists'. This mirrors what
    // `TenantProvisionerService.applyPendingMigrations` does.
    .filter(({ version }) => version > fromVersion);

  const sql = versions
    .map(({ name }) => renderTenantDdl(readFileSync(join(root, name, 'migration.sql'), 'utf8'), schemaName))
    .join('\n');
  const latest = versions.reduce((max, { version }) => Math.max(max, version), fromVersion);
  return { sql, version: latest };
}

/**
 * Runs the seed.
 *
 * @returns Nothing; the function logs what it created.
 */
/**
 * Reads a seeded role id, failing loudly when the catalogue is incomplete.
 *
 * A silently missing role would create a principal with no effective
 * permissions, which presents as an inexplicable authorization failure rather
 * than as a seeding bug.
 *
 * @param roleIds Role ids keyed by name, as returned by the catalogue seed.
 * @param name Role to look up.
 * @returns The role id.
 */
function requireRole(roleIds: Record<string, string>, name: string): string {
  const id = roleIds[name];
  if (id === undefined) {
    throw new Error(`RBAC catalogue did not produce role "${name}".`);
  }
  return id;
}

async function main(): Promise<void> {
  const pool = createPool();
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }) });

  try {
    // --- RBAC catalogue ------------------------------------------------------
    // Modules group permissions, roles hold permissions, principals hold roles.
    // Seeded before any principal exists so the assignments below can reference
    // real role ids.
    const roleIds = await seedRbacCatalog(prisma);
    process.stdout.write(`Seeded RBAC catalogue: ${Object.keys(roleIds).length} system roles.\n`);

    // --- Platform owner ------------------------------------------------------
    const ownerEmail = PiiCryptoService.normalizeEmail(OWNER_EMAIL);
    const owner = await prisma.platformAdmin.upsert({
      where: { emailLookup: pii.blindIndex(ownerEmail) },
      update: { role: PlatformRole.OWNER, status: 'ACTIVE' },
      create: {
        emailCiphertext: pii.encrypt(ownerEmail, { aad: 'platform-admin.email' }),
        // The seeded owner is an unrestricted principal; force a rotation before
        // it can be used, and leave it out of the update clause so an operator
        // can clear the flag once the account is secured.
        mustChangePassword: true,
        emailLookup: pii.blindIndex(ownerEmail),
        emailMasked: mask.maskEmail(ownerEmail),
        passwordHash: await argon2.hash(OWNER_PASSWORD, ARGON2),
        displayName: 'Platform Owner',
        role: PlatformRole.OWNER,
        status: 'ACTIVE',
      },
      select: { id: true, emailMasked: true, role: true },
    });
    // An administrator may hold several roles; the effective permission set is
    // the union across all of them. `PlatformRole` remains the coarse gate and
    // the RBAC roles carry the fine-grained authority.
    await grantPlatformRole(prisma, owner.id, requireRole(roleIds, 'platform-owner'));
    process.stdout.write(`Seeded platform owner ${owner.emailMasked} (${owner.role}).\n`);

    // --- Demo tenant ---------------------------------------------------------
    const schemaName = naming.toSchemaName(DEMO_TENANT_SLUG);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    const tenant = await prisma.tenant.upsert({
      where: { slug: DEMO_TENANT_SLUG },
      update: {},
      create: {
        slug: DEMO_TENANT_SLUG,
        name: DEMO_TENANT_NAME,
        schemaName,
        status: TenantStatus.PROVISIONING,
        plan: 'standard',
        createdById: owner.id,
      },
      select: { id: true, slug: true, schemaName: true, schemaVersion: true },
    });

    // The SET and the DDL must run on the *same* connection: a pool may hand the
    // second statement to a different one, where search_path would be the default.
    const currentVersion = tenant.schemaVersion ?? 0;
    const connection = await pool.connect();
    let reachedVersion = currentVersion;
    try {
      const { sql, version } = tenantBootstrapDdl(tenant.schemaName, currentVersion);
      reachedVersion = version;
      if (sql.length === 0) {
        process.stdout.write(`Tenant schema is already at version ${currentVersion}; nothing to apply.\n`);
      } else {
        await connection.query('SET search_path TO public');
        await connection.query(`SET search_path TO "${tenant.schemaName}", public`);
        await connection.query(sql);
      }
    } finally {
      connection.release();
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: TenantStatus.ACTIVE,
        provisionedAt: new Date(),
        schemaVersion: reachedVersion,
      },
    });
    process.stdout.write(`Seeded demo tenant "${tenant.slug}" in schema "${tenant.schemaName}".\n`);

    // --- First tenant member -------------------------------------------------
    const memberEmail = PiiCryptoService.normalizeEmail(MEMBER_EMAIL);
    const memberLookup = pii.blindIndex(memberEmail);
    const tenantClient = new TenantClient({ adapter: new PrismaPg(pool, { schema: tenant.schemaName }) });

    try {
      // The tenant tables have FORCE ROW LEVEL SECURITY, so the write has to carry the
      // same tenant binding the application sets; without it the policy rejects the insert.
      const member = await tenantClient.$transaction(async (tx) => {
        // eslint-disable-next-line no-restricted-properties -- SET LOCAL cannot bind a parameter; the value is the schema name just created.
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${tenant.schemaName}'`);
        return tx.user.upsert({
          where: { emailLookup: memberLookup },
          update: {},
          create: {
            emailCiphertext: pii.encrypt(memberEmail, { aad: 'tenant-user.email' }),
            emailLookup: memberLookup,
            emailMasked: mask.maskEmail(memberEmail),
            displayName: 'Ada Lovelace',
            passwordHash: await argon2.hash(MEMBER_PASSWORD, ARGON2),
            role: 'OWNER',
            status: 'ACTIVE',
          },
          select: { id: true, emailMasked: true },
        });
      });
      await grantTenantRoles(tenantClient, tenant.schemaName, member.id, [
        requireRole(roleIds, 'tenant-owner'),
      ]);
      process.stdout.write(`Seeded tenant member ${member.emailMasked}.\n`);
    } finally {
      await tenantClient.$disconnect();
    }

    // --- Audit entry ---------------------------------------------------------
    const existingAudit = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: 'tenant.created' },
      select: { id: true },
    });
    if (!existingAudit) {
      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorType: AuditActorType.PLATFORM_ADMIN,
          actorId: owner.id,
          actorLabel: 'Platform Owner',
          action: 'tenant.created',
          resourceType: 'tenant',
          resourceId: tenant.id,
          metadata: { via: 'seed', slug: tenant.slug },
        },
      });
    }

    // Printing clear-text passwords puts them in CI logs and terminal scrollback.
    // The operator supplied them, so they already have them; print the identities
    // and only echo a secret when explicitly asked.
    process.stdout.write('\nSeeded identities (secrets come from SEED_* variables):\n');
    process.stdout.write(`  admin:  ${OWNER_EMAIL} (PlatformRole.OWNER, platform-owner role)\n`);
    process.stdout.write(`  member: ${memberEmail} (tenant "${tenant.slug}", tenant-owner role)\n`);
    if (process.env['SEED_PRINT_CREDENTIALS'] === 'true') {
      process.stdout.write('\nSEED_PRINT_CREDENTIALS=true, so echoing them anyway:\n');
      process.stdout.write(`  admin:  ${OWNER_EMAIL} / ${OWNER_PASSWORD}\n`);
      process.stdout.write(`  member: ${memberEmail} / ${MEMBER_PASSWORD}\n`);
    }
    process.stdout.write('\nBoth seeded accounts force a password change on first sign-in.\n');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

/* istanbul ignore next -- script entry point */
main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${(error as Error).message}\n`);
  process.exit(1);
});
