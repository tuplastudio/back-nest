import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, TenantStatus } from '../generated/control-plane/enums';
import { Prisma, type Tenant } from '../generated/control-plane/client';
import { ApiKeyService } from '../api-keys/api-key.service';
import { AuditLogService } from '../audit/audit-log.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { RequestContextService } from './request-context.service';
import { TenantProvisionerService } from './tenant-provisioner.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantSchemaNamingService } from './tenant-schema-naming.service';
import { ConflictException, NotFoundException } from '../common/errors/app.exception';
import type { TenantDetailDto, TenantStatsDto, TenantSummaryDto } from './dto/tenant-response.dto';

/**
 * Cursor-paginated result set.
 */
export interface Page<T> {
  /** Rows for this page. */
  readonly items: readonly T[];
  /** Opaque cursor for the next page, or `null` at the end. */
  readonly nextCursor: string | null;
  /** Total matching rows, for pagination UIs. */
  readonly total: number;
}

/**
 * Input for creating a tenant.
 */
export interface CreateTenantInput {
  /** Business slug; must satisfy the tenant slug allow-list. */
  readonly slug: string;
  /** Display name. */
  readonly name: string;
  /** Commercial plan. */
  readonly plan?: string;
  /** IANA timezone. */
  readonly timezone?: string;
  /** Locale tag. */
  readonly locale?: string;
  /** Non-PII configuration object. */
  readonly settings?: Record<string, unknown>;
  /** Non-PII support contact label. */
  readonly supportContact?: string;
}

/**
 * Input for updating a tenant.
 */
export interface UpdateTenantInput {
  /** New display name. */
  readonly name?: string;
  /** New plan. */
  readonly plan?: string;
  /** New timezone. */
  readonly timezone?: string;
  /** New locale. */
  readonly locale?: string;
  /** Replacement configuration. */
  readonly settings?: Record<string, unknown>;
  /** New support contact. */
  readonly supportContact?: string;
}

/**
 * Tenant lifecycle and administration.
 *
 * Invariants this service enforces
 * --------------------------------
 *  * A tenant row is created in `PROVISIONING` **before** the schema exists, so
 *    a crash mid-provisioning leaves an auditable, recoverable state rather than
 *    an orphan schema nobody owns.
 *  * The schema is activated only after its DDL applied cleanly.
 *  * Suspension revokes every API key in the same operation, so a suspended
 *    tenant's integrations lose access immediately.
 *  * Deletion is soft. Dropping a schema is a separate, explicitly confirmed
 *    call, so a mistaken DELETE cannot destroy data.
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  /**
   * @param prisma Control-plane Prisma service.
   * @param provisioner Schema creation and migration service.
   * @param resolver Tenant resolver, whose cache is invalidated on writes.
   * @param naming Schema naming service.
   * @param apiKeys API key service.
   * @param audit Audit trail writer.
   * @param requestContext Request-scoped context holder.
   */
  constructor(
    private readonly prisma: ControlPlanePrismaService,
    private readonly provisioner: TenantProvisionerService,
    private readonly resolver: TenantResolverService,
    private readonly naming: TenantSchemaNamingService,
    private readonly apiKeys: ApiKeyService,
    private readonly audit: AuditLogService,
    private readonly requestContext: RequestContextService,
  ) {}

  /**
   * Creates a tenant and provisions its schema.
   *
   * @param input Tenant attributes.
   * @returns The provisioned tenant.
   * @throws {ConflictException} When the slug is already taken.
   */
  async create(input: CreateTenantInput): Promise<TenantDetailDto> {
    // Validate before touching the database so a bad slug never creates a row.
    this.naming.assertValidSlug(input.slug);
    const schemaName = this.naming.toSchemaName(input.slug);

    const existing = await this.prisma.client.tenant.findUnique({
      where: { slug: input.slug },
      select: { id: true, slug: true, status: true },
    });
    // A create that failed mid-provisioning left the row in PROVISIONING: creating it
    // again retries the (idempotent) schema provisioning instead of a permanent 409.
    if (existing?.status === TenantStatus.PROVISIONING) {
      this.logger.warn(`Retrying provisioning for tenant "${existing.slug}" (${existing.id}).`);
      await this.provisionAndActivate(existing);
      return this.toDetail(await this.requireTenant(existing.id));
    }
    if (existing) {
      throw new ConflictException(`Tenant slug "${input.slug}" is already in use.`);
    }

    const tenant = await this.prisma.client.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        schemaName,
        status: TenantStatus.PROVISIONING,
        plan: input.plan ?? 'standard',
        timezone: input.timezone ?? 'UTC',
        locale: input.locale ?? 'en-US',
        settings: (input.settings ?? {}) as Prisma.InputJsonValue,
        supportContact: input.supportContact ?? null,
        createdById: this.currentActorId(),
      },
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      actorLabel: this.currentActorLabel(),
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenant.id,
      metadata: { slug: tenant.slug, schemaName, plan: tenant.plan },
      ...this.requestMeta(),
    });

    await this.provisionAndActivate(tenant);

    this.logger.log(`Created tenant "${tenant.slug}" (${tenant.id}).`);
    // Re-read so the response reflects the post-provisioning state (ACTIVE with
    // the applied schema version) rather than the row as first inserted.
    const activated = await this.requireTenant(tenant.id);
    return this.toDetail(activated);
  }

  /** Provisions the schema and activates the tenant; on failure the row stays PROVISIONING. */
  private async provisionAndActivate(tenant: { id: string; slug: string }): Promise<void> {
    try {
      await this.provisioner.provisionSchema(tenant.slug);
      await this.provisioner.markActive(tenant.id);
    } catch (error) {
      // Leave the row in PROVISIONING: it documents the failure and lets an
      // operator retry without re-creating the tenant.
      this.logger.error(
        `Provisioning failed for tenant "${tenant.slug}": ${(error as Error).message}. ` +
          'The tenant remains in PROVISIONING and can be retried.',
      );
      await this.audit.record({
        tenantId: tenant.id,
        actorType: AuditActorType.SYSTEM,
        action: 'tenant.provision-failed',
        resourceType: 'tenant',
        resourceId: tenant.id,
        outcome: 'FAILURE',
        metadata: { error: (error as Error).message.slice(0, 300) },
        ...this.requestMeta(),
      });
      throw error;
    }
  }

  /**
   * Lists tenants with cursor pagination.
   *
   * @param filters Optional status and search filters.
   * @returns A page of tenant summaries.
   */
  async list(filters: {
    status?: TenantStatus;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<TenantSummaryDto>> {
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);

    const where: Prisma.TenantWhereInput = {
      // Soft-deleted tenants are excluded from every listing.
      status: filters.status ?? { not: TenantStatus.DELETED },
      ...(filters.search
        ? {
            OR: [
              { slug: { contains: filters.search.toLowerCase(), mode: 'insensitive' as const } },
              { name: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(filters.cursor ? { createdAt: { lt: new Date(filters.cursor) } } : {}),
    };

    const [rows, total, keyCounts] = await Promise.all([
      this.prisma.client.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.client.tenant.count({ where }),
      this.prisma.client.apiKey.groupBy({
        by: ['tenantId'],
        where: { status: 'ACTIVE', tenantId: { in: await this.pendingIds(where, limit) } },
        _count: { _all: true },
      }),
    ]);

    const counts = new Map(keyCounts.map((entry) => [entry.tenantId, entry._count._all]));
    const last = rows.at(-1);

    return {
      items: rows.map((row) => this.toSummary(row, counts.get(row.id) ?? 0)),
      nextCursor: rows.length === limit && last ? last.createdAt.toISOString() : null,
      total,
    };
  }

  /**
   * Retrieves a single tenant.
   *
   * @param id Tenant UUID.
   * @returns The tenant detail.
   * @throws {NotFoundException} When the tenant does not exist.
   */
  async findById(id: string): Promise<TenantDetailDto> {
    const tenant = await this.requireTenant(id);
    const activeKeys = await this.prisma.client.apiKey.count({
      where: { tenantId: id, status: 'ACTIVE' },
    });
    return this.toDetail(tenant, activeKeys);
  }

  /**
   * Retrieves a tenant by slug.
   *
   * @param slug Tenant slug.
   * @returns The tenant detail.
   * @throws {NotFoundException} When the tenant does not exist.
   */
  async findBySlug(slug: string): Promise<TenantDetailDto> {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      throw new NotFoundException('Tenant', slug);
    }
    const activeKeys = await this.prisma.client.apiKey.count({
      where: { tenantId: tenant.id, status: 'ACTIVE' },
    });
    return this.toDetail(tenant, activeKeys);
  }

  /**
   * Updates mutable tenant attributes.
   *
   * The slug and schema name are intentionally immutable: changing them would
   * silently repoint every subdomain and every cached client at different data.
   *
   * @param id Tenant UUID.
   * @param input Fields to change.
   * @returns The updated tenant detail.
   */
  async update(id: string, input: UpdateTenantInput): Promise<TenantDetailDto> {
    const existing = await this.requireTenant(id);

    const updated = await this.prisma.client.tenant.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.settings !== undefined ? { settings: input.settings as Prisma.InputJsonValue } : {}),
        ...(input.supportContact !== undefined ? { supportContact: input.supportContact } : {}),
      },
    });

    this.resolver.invalidate({ id: updated.id, slug: updated.slug });
    void existing;

    await this.audit.record({
      tenantId: id,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      actorLabel: this.currentActorLabel(),
      action: 'tenant.updated',
      resourceType: 'tenant',
      resourceId: id,
      metadata: { changedFields: Object.keys(input) },
      ...this.requestMeta(),
    });

    return this.toDetail(updated);
  }

  /**
   * Suspends a tenant and revokes its API keys.
   *
   * The tenant's data is preserved. Reversible with
   * {@link TenantsService.reactivate}.
   *
   * @param id Tenant UUID.
   * @param reason Non-PII reason recorded in the audit trail.
   * @returns The updated tenant detail.
   */
  async suspend(id: string, reason?: string): Promise<TenantDetailDto> {
    const current = await this.requireTenant(id);

    // Invalidate *before* the write as well as after it. A concurrent
    // `resolveForRequest` that read the ACTIVE row just before the commit can
    // otherwise call `storeAndReturn` after the post-write invalidation and
    // reinsert an ACTIVE entry for another full cache TTL.
    this.resolver.invalidate({ id: current.id, slug: current.slug });

    const [tenant, revokedKeys] = await Promise.all([
      this.prisma.client.tenant.update({
        where: { id },
        data: { status: TenantStatus.SUSPENDED, suspendedAt: new Date() },
      }),
      this.apiKeys.revokeAllForTenant(id),
    ]);

    this.resolver.invalidate({ id: tenant.id, slug: tenant.slug });

    await this.audit.record({
      tenantId: id,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      actorLabel: this.currentActorLabel(),
      action: 'tenant.suspended',
      resourceType: 'tenant',
      resourceId: id,
      metadata: { reason: reason ?? 'unspecified', revokedApiKeys: revokedKeys },
      ...this.requestMeta(),
    });

    this.logger.warn(`Suspended tenant "${tenant.slug}" and revoked ${revokedKeys} API keys.`);
    return this.toDetail(tenant);
  }

  /**
   * Returns a suspended or deprecated tenant to service.
   *
   * @param id Tenant UUID.
   * @returns The updated tenant detail.
   */
  async reactivate(id: string): Promise<TenantDetailDto> {
    await this.requireTenant(id);
    await this.provisioner.markActive(id);

    const updated = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id } });
    this.resolver.invalidate({ id: updated.id, slug: updated.slug });

    await this.audit.record({
      tenantId: id,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      actorLabel: this.currentActorLabel(),
      action: 'tenant.reactivated',
      resourceType: 'tenant',
      resourceId: id,
      ...this.requestMeta(),
    });

    return this.toDetail(updated);
  }

  /**
   * Soft-deletes a tenant.
   *
   * Data and schema are retained; {@link TenantsService.purge} performs the
   * irreversible step behind a separate confirmation.
   *
   * @param id Tenant UUID.
   * @returns The updated tenant detail.
   */
  async softDelete(id: string): Promise<TenantDetailDto> {
    await this.requireTenant(id);

    await this.apiKeys.revokeAllForTenant(id);
    const updated = await this.prisma.client.tenant.update({
      where: { id },
      data: { status: TenantStatus.DELETED, deletedAt: new Date(), suspendedAt: new Date() },
    });
    this.resolver.invalidate({ id: updated.id, slug: updated.slug });

    await this.audit.record({
      tenantId: id,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      actorLabel: this.currentActorLabel(),
      action: 'tenant.deleted',
      resourceType: 'tenant',
      resourceId: id,
      ...this.requestMeta(),
    });

    this.logger.warn(`Soft-deleted tenant "${updated.slug}". Schema retained pending retention expiry.`);
    return this.toDetail(updated);
  }

  /**
   * Drops a tenant's schema permanently.
   *
   * @param id Tenant UUID.
   * @param confirmation Must equal the tenant slug, guarding against a
   * mistyped id deleting the wrong schema.
   * @throws {ConflictException} When the confirmation does not match.
   */
  async purge(id: string, confirmation: string): Promise<void> {
    const tenant = await this.requireTenant(id);
    if (confirmation !== tenant.slug) {
      throw new ConflictException(
        `Confirmation "${confirmation}" does not match tenant slug "${tenant.slug}".`,
      );
    }
    await this.provisioner.dropSchema(id);
  }

  /**
   * Applies any pending tenant migrations to an existing tenant.
   *
   * @param id Tenant UUID.
   * @returns The migration versions that were applied.
   */
  async migrate(id: string): Promise<number[]> {
    const tenant = await this.requireTenant(id);
    return this.provisioner.applyPendingMigrations(tenant.schemaName);
  }

  /**
   * Returns aggregate counts for the administration dashboard.
   *
   * @returns Counts by tenant status.
   */
  async stats(): Promise<TenantStatsDto> {
    const [grouped, activeKeys] = await Promise.all([
      this.prisma.client.tenant.groupBy({
        by: ['status'],
        where: { status: { not: TenantStatus.DELETED } },
        _count: { _all: true },
      }),
      this.prisma.client.apiKey.count({ where: { status: 'ACTIVE' } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const entry of grouped) {
      byStatus[entry.status] = entry._count._all;
    }

    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
      activeApiKeys: activeKeys,
    };
  }

  /**
   * Loads a tenant or throws.
   *
   * @param id Tenant UUID.
   * @returns The tenant row.
   * @throws {NotFoundException} When the tenant does not exist.
   */
  private async requireTenant(id: string): Promise<Tenant> {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant', id);
    }
    return tenant;
  }

  /**
   * Maps a tenant row to its API projection.
   *
   * @param tenant The tenant row.
   * @param activeApiKeyCount Active key count.
   * @returns The summary projection.
   */
  private toSummary(tenant: Tenant, activeApiKeyCount: number): TenantSummaryDto {
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      timezone: tenant.timezone,
      activeApiKeyCount,
      createdAt: tenant.createdAt,
    };
  }

  /**
   * Maps a tenant row to the detail projection.
   *
   * @param tenant The tenant row.
   * @param activeApiKeyCount Active key count, computed when not supplied.
   * @returns The detail projection.
   */
  private toDetail(tenant: Tenant, activeApiKeyCount = 0): TenantDetailDto {
    return {
      ...this.toSummary(tenant, activeApiKeyCount),
      schemaName: tenant.schemaName,
      schemaVersion: tenant.schemaVersion,
      provisionedAt: tenant.provisionedAt,
      settings: tenant.settings as Record<string, unknown>,
      utcOffsetMinutes: this.offsetMinutes(tenant.timezone),
    };
  }

  /**
   * Computes the UTC offset of an IANA timezone.
   *
   * A bad timezone falls back to UTC rather than throwing: a display setting
   * should never make a tenant unusable.
   *
   * @param timezone IANA timezone identifier.
   * @returns Offset in minutes east of UTC.
   */
  private offsetMinutes(timezone: string): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'longOffset',
      });
      const part = formatter.formatToParts(new Date()).find((entry) => entry.type === 'timeZoneName');
      const match = part ? /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part.value) : null;
      if (!match) {
        return 0;
      }
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
    } catch {
      return 0;
    }
  }

  /**
   * Collects tenant ids matching a filter, for the key-count aggregate.
   *
   * @param where Filter to apply.
   * @param limit Maximum ids to return.
   * @returns Matching tenant ids.
   */
  private async pendingIds(where: Prisma.TenantWhereInput, limit: number): Promise<string[]> {
    const rows = await this.prisma.client.tenant.findMany({ where, take: limit, select: { id: true } });
    return rows.map((row) => row.id);
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

  /**
   * Current actor label from the request context.
   *
   * @returns The actor's display name, or `null`.
   */
  private currentActorLabel(): string | null {
    const principal = this.requestContext.principal;
    return principal && 'displayName' in principal ? principal.displayName : null;
  }
}
