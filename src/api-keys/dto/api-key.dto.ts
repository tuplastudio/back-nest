import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Payload for creating an API key.
 */
export class CreateApiKeyDto {
  /**
   * Operator-facing label.
   *
   * Shown in listings and audit entries, so it should describe the integration
   * (`ci-pipeline`, `partner-sync`) rather than a person.
   */
  @ApiProperty({ example: 'ci-pipeline', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * Capabilities to grant.
   *
   * Must be a subset of the grantable scopes returned by `GET /api-keys`. A
   * wildcard `*` is deliberately **not** grantable: it would defeat the point of
   * scoping and makes accidental over-grant impossible to notice in review.
   */
  @ApiProperty({
    example: ['projects:read', 'projects:write'],
    isArray: true,
    description: 'Subset of the grantable scopes. Wildcards other than `resource:*` are not allowed.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];

  /**
   * Absolute expiry.
   *
   * When omitted, `API_KEY_DEFAULT_TTL_DAYS` applies. An expiring key forces a
   * rotation cadence, which bounds the damage a leaked key can do.
   */
  @ApiPropertyOptional({
    example: '2026-03-01T00:00:00.000Z',
    description: 'Absolute expiry. Defaults to API_KEY_DEFAULT_TTL_DAYS when omitted.',
    format: 'date-time',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'expiresAt must be an ISO 8601 timestamp' })
  expiresAt?: string;
}

/**
 * Query parameters for listing API keys.
 */
export class ListApiKeysQueryDto {
  /**
   * Whether to include revoked and expired keys.
   *
   * Off by default so an operator's default view shows only live credentials.
   */
  @ApiPropertyOptional({
    example: 'false',
    description: 'Include revoked and expired keys in the response.',
  })
  @IsOptional()
  @Matches(/^(true|false)$/, { message: 'includeRevoked must be "true" or "false"' })
  includeRevoked?: string;
}
