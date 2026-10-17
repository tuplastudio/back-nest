import { Injectable, Logger } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditActorType, TenantStatus } from '../generated/control-plane/enums';
import { AuditLogService } from '../audit/audit-log.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { Prisma } from '../generated/control-plane/client';
import { RequestContextService } from './request-context.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantSchemaNamingService } from './tenant-schema-naming.service';
import { AppException } from '../common/errors/app.exception';
import { quoteIdentifier } from '../prisma/identifiers';
import { SafeSqlService } from '../prisma/safe-sql.service';
import { renderTenantDdl } from '../prisma/tenant-ddl';

/**
 * A versioned migration applied to every tenant schema.
 */
export interface TenantMigration {
  /** Monotonic version, parsed from the directory name. */
  readonly version: number;
  /** Directory name, e.g. `0002_add_projects`. */
  readonly name: string;
  /** Raw SQL script. */
  readonly sql: string;
}

/**
 * Raised when tenant schema provisioning fails.
 */
export class TenantProvisioningException extends AppException {
  /**
   * @param message What failed.
   * @param cause Underlying error.
   */
  constructor(message: string, cause?: unknown) {
    super(message, 'TENANT_PROVISIONING_FAILED', 500);
    this.cause = cause;
  }
}

/**
 * Creates, migrates and destroys the PostgreSQL schema behind each tenant.
 *
 * Why raw DDL is unavoidable
 * --------------------------
 * Prisma Migrate targets one schema at a time. Tenant schemas are created at
 * runtime, one per tenant, so their DDL cannot live in the control plane's
 * migration history. The approach here:
 *
 *  1. `prisma/schema.tenant.prisma` remains the single source of truth.
 *  2. `npm run prisma:tenant:diff` renders it to SQL under
 *     `prisma/migrations/tenant/<version>_<name>/migration.sql`.
 *  3. At provisioning time the applied versions are tracked in
 *     `Tenant.schemaVersion`; only migrations newer than that are executed.
 *
 * Every statement runs with `search_path` set to the tenant schema, so the
 * unqualified names in the migration file resolve inside the new schema.
 *
 * SQL injection
 * -------------
 * The only dynamic value in any statement is a schema name, and it passes
 * {@link quoteIdentifier}, which enforces `^[a-z_][a-z0-9_]{0,62}$` before
 * quoting. Combined with
 * {@link TenantSchemaNamingService.toSchemaName}, which forces the `tenant_`
 * prefix, a tenant can never address `public`, `pg_catalog` or an information
 * schema. `SET search_path` additionally uses
 * `pg_catalog.set_config(..., false)`, i.e. transaction-local, so the setting
 * cannot leak to another connection.
 */
@Injectable()
export class TenantProvisionerService {
  private readonly logger = new Logger(TenantProvisionerService.name);
  private migrations: TenantMigration[] | null = null;

  /**
   * @param prisma Control-plane Prisma service.
   * @param tenantPrisma Tenant client factory, evicted after schema changes.
   * @param resolver Tenant resolver, whose cache must be invalidated on writes.
   * @param naming Schema naming service.
   * @param audit Audit trail writer.
   * @param requestContext Request-scoped context holder.
   */
  constructor(
    private readonly prisma: ControlPlanePrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly resolver: TenantResolverService,
    private readonly naming: TenantSchemaNamingService,
    private readonly audit: AuditLogService,
    private readonly safeSql: SafeSqlService,
    private readonly requestContext: RequestContextService,
  ) {}

  /**
   * Creates the tenant schema and applies all pending migrations.
   *
   * Idempotent: an existing schema is reused and only missing migrations run, so
   * a retried provisioning request converges rather than failing.
   *
   * @param slug Validated tenant slug.
   * @returns The schema name that now stores the tenant's data.
   * @throws {TenantProvisioningException} When any DDL statement fails.
   */
  async provisionSchema(slug: string): Promise<string> {
    const schemaName = this.naming.toSchemaName(slug);
    await this.prisma.client.$transaction(async (tx) => {
      await this.executeInSchema(
        tx,
        schemaName,
        `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`,
      );
    });

    // Grants for the data-plane role are applied by the tenant migration itself, so
    // every schema that gets these tables also gets them.
    await this.applyPendingMigrations(schemaName);

    // A client cached before the schema existed would be bound to a schema that
    // has since changed, so drop it.
    await this.tenantPrisma.evict(schemaName);
    // Evict by slug only: the registry row does not exist yet at this point, so
    // passing a placeholder id would clear the `id:` key and miss the `slug:` one.
    this.resolver.invalidate({ id: '', slug });

    this.logger.log(`Provisioned schema "${schemaName}" for tenant "${slug}".`);
    return schemaName;
  }

  /**
   * Applies every migration newer than the tenant's recorded version.
   *
   * @param schemaName Target tenant schema.
   * @returns The versions that were applied.
   */
  async applyPendingMigrations(schemaName: string): Promise<number[]> {
    const tenant = await this.prisma.client.tenant.findFirst({
      where: { schemaName },
      select: { id: true, schemaVersion: true },
    });
    const currentVersion = tenant?.schemaVersion ?? 0;

    const migrations = (await this.loadMigrations()).filter((m) => m.version > currentVersion);
    if (migrations.length === 0) {
      return [];
    }

    const applied: number[] = [];
    for (const migration of migrations) {
      await this.prisma.client.$transaction(async (tx) => {
        await this.executeInSchema(tx, schemaName, renderTenantDdl(migration.sql, schemaName));
        if (tenant) {
          await tx.tenant.update({
            where: { id: tenant.id },
            data: { schemaVersion: migration.version },
          });
        }
      });
      applied.push(migration.version);
      this.logger.log(`Applied tenant migration ${migration.name} to "${schemaName}".`);
    }

    return applied;
  }

  /**
   * Marks a tenant as ready to serve traffic.
   *
   * @param tenantId Tenant to activate.
   * @throws {TenantProvisioningException} When the tenant is unknown.
   */
  async markActive(tenantId: string): Promise<void> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, schemaName: true },
    });
    if (!tenant) {
      throw new TenantProvisioningException(`Cannot activate unknown tenant ${tenantId}.`);
    }

    await this.prisma.client.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.ACTIVE, provisionedAt: new Date(), suspendedAt: null },
    });

    this.resolver.invalidate({ id: tenantId, slug: tenant.slug });

    await this.audit.record({
      tenantId,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      action: 'tenant.activated',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { schemaName: tenant.schemaName },
      ...this.requestMeta(),
    });
  }

  /**
   * Drops a tenant schema.
   *
   * Irreversible, and therefore only reachable through an explicitly confirmed
   * deprovision call.
   *
   * The name is re-read from storage here rather than derived from the slug, so
   * the reserved `tenant_` namespace is re-asserted before the identifier reaches
   * DDL. `quoteIdentifier` alone only enforces the character pattern, which
   * `public`, `pg_catalog` and `information_schema` all satisfy, and this runs on
   * the control-plane client whose own schema is `public`. Every other consumer of
   * `Tenant.schemaName` makes the same check; this path must too.
   *
   * @param tenantId Tenant whose schema should be dropped.
   * @throws {TenantProvisioningException} When the tenant is unknown, or its stored schema name is outside the tenant namespace.
   */
  async dropSchema(tenantId: string): Promise<void> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, schemaName: true },
    });
    if (!tenant) {
      throw new TenantProvisioningException(`Cannot drop schema for unknown tenant ${tenantId}.`);
    }
    if (!this.naming.isValidSchemaName(tenant.schemaName)) {
      throw new TenantProvisioningException(
        `Refusing to drop schema for tenant ${tenantId}: stored schema name "${tenant.schemaName}" is outside the reserved tenant_ namespace.`,
      );
    }

    await this.tenantPrisma.evict(tenant.schemaName);

    // `DROP SCHEMA ... CASCADE` is destructive by nature; the identifier has
    // passed both the naming allow-list and the namespace check above. DDL
    // cannot be parameterised, so the value is interpolated as a validated,
    // quoted identifier rather than bound.
    // The audited helper, not a hand-rolled quote: it enforces the reserved
    // `tenant_` namespace as well as the character pattern, so the destructive
    // statement cannot be aimed at `public` even if a caller bypasses the
    // naming service.
    const schema = this.safeSql.tenantSchema(tenant.schemaName).sql;
    // eslint-disable-next-line no-restricted-properties -- DDL cannot be parameterised; the identifier comes from the audited helper.
    await this.prisma.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

    this.logger.warn(`Dropped schema "${tenant.schemaName}" for tenant "${tenant.slug}".`);

    // The registry row keeps its status, so the resolver must be told; otherwise a
    // purged tenant stays resolvable as ACTIVE for the remainder of the cache TTL.
    this.resolver.invalidate({ id: tenant.id, slug: tenant.slug });

    await this.audit.record({
      tenantId,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      action: 'tenant.schema-dropped',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { schemaName: tenant.schemaName },
      ...this.requestMeta(),
    });
  }

  /**
   * Verifies that a tenant schema exists and holds the expected tables.
   *
   * @param schemaName Schema to inspect.
   * @returns `true` when the schema and its tables are present.
   */
  async schemaIsHealthy(schemaName: string): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<Array<{ table_name: string }>>(Prisma.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schemaName}
    `);
    return rows.some((row) => row.table_name === 'users');
  }

  /**
   * Reads and caches the tenant migration scripts.
   *
   * Cached because provisioning runs on a rare path but scans the filesystem;
   * re-reading on every call would be wasteful in a burst of tenant creations.
   *
   * @returns Migrations ordered by version.
   * @throws {TenantProvisioningException} When the directory cannot be read.
   */
  private async loadMigrations(): Promise<TenantMigration[]> {
    if (this.migrations) {
      return this.migrations;
    }

    const baseDir = join(process.cwd(), 'prisma', 'tenant-migrations');
    let directories: string[];
    try {
      directories = (await readdir(baseDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      throw new TenantProvisioningException(
        `Cannot read tenant migrations from ${baseDir}: ${(error as Error).message}. ` +
          'Run `npm run prisma:tenant:diff` to render them from prisma/schema.tenant.prisma.',
        error,
      );
    }

    const migrations: TenantMigration[] = [];
    for (const directory of directories) {
      const version = Number.parseInt(directory, 10);
      if (!Number.isInteger(version)) {
        this.logger.warn(
          `Skipping tenant migration directory "${directory}": name must start with a version.`,
        );
        continue;
      }
      const sql = await readFile(join(baseDir, directory, 'migration.sql'), 'utf8');
      migrations.push({ version, name: directory, sql });
    }

    migrations.sort((a, b) => a.version - b.version);
    this.migrations = migrations;

    if (migrations.length === 0) {
      this.logger.warn('No tenant migrations found; new tenants will have an empty schema.');
    }
    return migrations;
  }

  /**
   * Runs a SQL script inside a specific schema.
   *
   * `search_path` is set transaction-locally with `pg_catalog.set_config`, so the
   * setting is scoped to the current transaction and cannot affect other
   * connections holding objects from the shared pool.
   *
   * @param tx Transaction client.
   * @param schemaName Target schema, already validated by the naming service.
   * @param sql Script to execute.
   * @throws {TenantProvisioningException} When the script fails.
   */
  private async executeInSchema(
    tx: Prisma.TransactionClient,
    schemaName: string,
    sql: string,
  ): Promise<void> {
    try {
      // eslint-disable-next-line no-restricted-properties -- SET LOCAL cannot bind a parameter; the identifier goes through the audited helper.
      await tx.$executeRawUnsafe(
        `SET LOCAL search_path TO ${this.safeSql.tenantSchema(schemaName).sql}, public`,
      );
      // eslint-disable-next-line no-restricted-properties -- repository-authored migration script, rewritten by renderTenantDdl; not attacker-supplied.
      await tx.$executeRawUnsafe(sql);
    } catch (error) {
      throw new TenantProvisioningException(
        `Failed to apply schema DDL to "${schemaName}": ${(error as Error).message}`,
        error,
      );
    }
  }

  /**
   * Audit metadata for the current request.
   *
   * @returns IP and user-agent hashes.
   */
  private requestMeta(): { ipHash: string | null; userAgentHash: string | null } {
    const context = this.requestContext.get();
    return { ipHash: context.ipHash, userAgentHash: context.userAgentHash };
  }

  /**
   * Current actor type from the request context.
   *
   * @returns The actor type, defaulting to `SYSTEM`.
   */
  private currentActorType(): AuditActorType {
    const principal = this.requestContext.principal;
    if (principal?.kind === 'tenant-user') {
      return AuditActorType.TENANT_USER;
    }
    if (principal?.kind === 'platform-admin') {
      return AuditActorType.PLATFORM_ADMIN;
    }
    return AuditActorType.SYSTEM;
  }

  /**
   * Current actor id from the request context.
   *
   * @returns The actor id, or `null`.
   */
  private currentActorId(): string | null {
    return this.requestContext.principal?.id ?? null;
  }
}
