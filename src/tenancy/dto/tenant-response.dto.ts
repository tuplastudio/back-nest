import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { TenantStatus } from '../../generated/control-plane/enums';

/**
 * Tenant projection returned by list endpoints.
 *
 * `schemaName` is intentionally absent: the physical schema is an internal
 * detail, and publishing it invites probing. It appears only in
 * {@link TenantDetailDto}.
 */
export class TenantSummaryDto {
  /** Tenant UUID. */
  @ApiProperty({ format: 'uuid' })
  id!: string;

  /** Business slug. */
  @ApiProperty({ example: 'acme' })
  slug!: string;

  /** Display name. */
  @ApiProperty({ example: 'ACME Corporation' })
  name!: string;

  /** Lifecycle status. */
  @ApiProperty({ enum: TenantStatus })
  status!: TenantStatus;

  /** Commercial plan key. */
  @ApiProperty({ example: 'standard' })
  plan!: string;

  /** IANA timezone. */
  @ApiProperty({ example: 'America/Mexico_City' })
  timezone!: string;

  /** Number of API keys currently in `ACTIVE` state. */
  @ApiProperty({ example: 3 })
  activeApiKeyCount!: number;

  /** Creation timestamp. */
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * Full tenant projection, including operator-only fields.
 */
export class TenantDetailDto extends TenantSummaryDto {
  /** Physical PostgreSQL schema holding this tenant's data. */
  @ApiProperty({
    example: 'tenant_acme_1a2b3c4d',
    description: 'Physical PostgreSQL schema. Returned only on the detail endpoint.',
  })
  schemaName!: string;

  /** Highest applied tenant migration version. */
  @ApiProperty({ example: 1 })
  schemaVersion!: number;

  /** When provisioning completed, or `null`. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  provisionedAt!: Date | null;

  /** Tenant configuration object. */
  @ApiProperty({ type: Object, additionalProperties: true })
  settings!: Record<string, unknown>;

  /** UTC offset of the tenant timezone, in minutes. */
  @ApiProperty({ example: -360, description: 'Minutes east of UTC for the tenant timezone.' })
  utcOffsetMinutes!: number;
}

/**
 * Pagination metadata.
 */
export class PageMetaDto {
  /** Cursor for the next page, or `null` when this is the last page. */
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  /** Total number of matching records. */
  @ApiProperty({ example: 12 })
  total!: number;
}

/**
 * Cursor-paginated list of tenants.
 */
export class TenantListDto {
  /** Tenants on this page. */
  @ApiProperty({ type: () => [TenantSummaryDto] })
  items!: TenantSummaryDto[];

  /** Pagination metadata. */
  @ApiProperty({ type: () => PageMetaDto })
  meta!: PageMetaDto;
}

/**
 * Aggregate counts for the administration dashboard.
 */
export class TenantStatsDto {
  /** Total non-deleted tenants. */
  @ApiProperty({ example: 8 })
  total!: number;

  /** Counts keyed by lifecycle status. */
  @ApiProperty({
    example: { ACTIVE: 6, PROVISIONING: 1, SUSPENDED: 1 },
    additionalProperties: { type: 'number' },
  })
  byStatus!: Record<string, number>;

  /** API keys currently active across all tenants. */
  @ApiProperty({ example: 14 })
  activeApiKeys!: number;
}

/**
 * Response of the schema migration endpoint.
 */
export class MigrateTenantDto {
  /** Migration versions applied by this call. */
  @ApiProperty({ type: [Number], example: [1, 2] })
  appliedVersions!: number[];
}

/**
 * Response of the purge endpoint.
 */
export class PurgeResultDto {
  /** Always `true` on success. */
  @ApiProperty({ example: true })
  purged!: true;
}

/**
 * Response describing which tenant the request resolved to.
 */
export class ResolvedTenantDto {
  /**
   * The resolved tenant.
   *
   * `null` when the request carried no tenant headers and used a non-tenant
   * subdomain, which is expected on control-plane routes.
   */
  @ApiProperty({ type: () => TenantSummaryDto, nullable: true })
  @ApiPropertyOptional({})
  tenant!: TenantSummaryDto | null;

  /** Header precedence actually applied, useful when debugging routing. */
  @ApiProperty({
    enum: ['header-id', 'header-slug', 'subdomain', 'none'],
    description: 'How the tenant was resolved for this request.',
  })
  resolvedBy!: 'header-id' | 'header-slug' | 'subdomain' | 'none';
}

/** Swagger schema name for {@link TenantSummaryDto}. */
export const TENANT_SUMMARY_SCHEMA = getSchemaPath(TenantSummaryDto);
