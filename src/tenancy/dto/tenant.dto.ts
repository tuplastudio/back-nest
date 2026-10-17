import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TenantStatus } from '../../generated/control-plane/enums';

/**
 * Slug rule, shared by DTOs and the service.
 *
 * The pattern is intentionally the same one enforced by
 * {@link TenantSchemaNamingService.assertValidSlug}: a lowercase alphanumeric
 * string with internal hyphens. Rejecting anything else at the edge means the
 * slug is always safe in a DNS label, an HTTP header and a database identifier.
 */
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Payload for creating a tenant.
 */
export class CreateTenantDto {
  /**
   * Business identifier used for subdomains (`<slug>.api.example.com`) and the
   * `X-Tenant-Slug` header. Immutable after creation.
   */
  @ApiProperty({
    example: 'acme',
    description: 'Business slug. Lowercase letters, digits and hyphens; max 63 characters.',
    pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$',
  })
  @IsString()
  @Matches(TENANT_SLUG_PATTERN, {
    message: 'slug must be lowercase alphanumeric with internal hyphens only',
  })
  @MaxLength(63)
  slug!: string;

  /** Display name shown in the administration console. */
  @ApiProperty({ example: 'ACME Corporation', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Commercial plan key consumed by the host product's billing module. */
  @ApiPropertyOptional({ example: 'standard', default: 'standard' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  plan?: string;

  /** IANA timezone used to render dates for this tenant's members. */
  @ApiPropertyOptional({ example: 'America/Mexico_City', default: 'UTC' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  /** Locale tag used for message formatting. */
  @ApiPropertyOptional({ example: 'es-MX', default: 'en-US' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;

  /**
   * Tenant configuration.
   *
   * Must be PII-free: these values are readable by every tenant member and are
   * surfaced in the administration UI.
   */
  @ApiPropertyOptional({ example: { featureFlags: { betaEditor: true } }, type: Object })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  /** Non-PII support label, e.g. a channel name. */
  @ApiPropertyOptional({ example: '#acme-support', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supportContact?: string;
}

/**
 * Payload for updating a tenant. Every field is optional; the slug and schema
 * name cannot be changed.
 */
export class UpdateTenantDto {
  /** New display name. */
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  /** New plan key. */
  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  plan?: string;

  /** New IANA timezone. */
  @ApiPropertyOptional({ example: 'Europe/Madrid' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  /** New locale tag. */
  @ApiPropertyOptional({ maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;

  /** Replacement configuration. */
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  /** New support contact label. */
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supportContact?: string;
}

/**
 * Payload for suspending a tenant.
 */
export class SuspendTenantDto {
  /** Non-PII reason recorded in the audit trail. */
  @ApiPropertyOptional({ example: 'Payment overdue', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/**
 * Payload for purging a tenant schema.
 *
 * The confirmation must equal the tenant's slug. Requiring the caller to type a
 * value they had to look up is a deliberate speed bump against destroying a
 * production schema with a mistyped id.
 */
export class PurgeTenantDto {
  /**
   * Must equal the tenant slug exactly.
   *
   * Capped at the slug length ceiling: a mismatch is reflected verbatim into the
   * 409 response body, and the request body limit (256 kB) is far larger than any
   * value that could ever be a confirmation.
   */
  @ApiProperty({ example: 'acme', description: 'Must match the tenant slug exactly.' })
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  confirm!: string;
}

/**
 * Query parameters accepted by the tenant list endpoint.
 */
export class ListTenantsQueryDto {
  /** Filter by lifecycle status. */
  @ApiPropertyOptional({ enum: TenantStatus })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;

  /** Case-insensitive match against slug or display name. */
  @ApiPropertyOptional({ example: 'acme' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  /** Page size, 1-100. */
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsString()
  limit?: string;

  /** Cursor returned by a previous page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}
