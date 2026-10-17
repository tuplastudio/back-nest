import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * API key metadata as returned by listing and revocation endpoints.
 *
 * Contains no secret material by design: the clear-text key exists only in the
 * creation and rotation responses.
 */
export class ApiKeyDto {
  /** Key UUID. */
  @ApiProperty({ format: 'uuid' })
  id!: string;

  /** Operator-facing label. */
  @ApiProperty({ example: 'ci-pipeline' })
  name!: string;

  /**
   * Public, non-secret prefix, e.g. `mtb_live_a1b2c3d4`.
   *
   * Safe to log and to display: it identifies the key without granting access.
   */
  @ApiProperty({ example: 'mtb_a1b2c3d4e5f60718' })
  prefix!: string;

  /** Granted scopes. */
  @ApiProperty({ example: ['projects:read', 'projects:write'], isArray: true })
  scopes!: string[];

  /** Lifecycle state. */
  @ApiProperty({ enum: ['ACTIVE', 'REVOKED', 'EXPIRED'] })
  status!: 'ACTIVE' | 'REVOKED' | 'EXPIRED';

  /** Absolute expiry, or `null` when the key never expires. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;

  /** When the key was revoked, or `null`. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt!: Date | null;

  /** Last time the key authenticated a request, or `null`. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastUsedAt!: Date | null;

  /** Number of requests the key has authenticated. */
  @ApiProperty({ example: 1284 })
  usageCount!: number;

  /** Predecessor key when this key was produced by a rotation. */
  @ApiProperty({ format: 'uuid', nullable: true })
  rotatedFromId!: string | null;

  /** Creation timestamp. */
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * API key metadata plus its one-time clear-text secret.
 *
 * Returned only by `POST /api-keys` and `POST /api-keys/:id/rotate`.
 */
export class ApiKeyCreatedDto extends ApiKeyDto {
  /**
   * The complete API key.
   *
   * Shown once and never recoverable: only an Argon2id hash is stored. If it is
   * lost, rotate the key rather than trying to retrieve it.
   */
  @ApiProperty({
    example: 'mtb_a1b2c3d4e5f60718_kZ9xQmR3vT8sW2yB7nL4pJ6hG1dF0cE5aU8iO3rN7qW2zX4bV6',
    description:
      'Complete API key, returned exactly once. Store it now — only an Argon2id hash is persisted and it cannot be recovered.',
  })
  secret!: string;
}

/**
 * List of API keys plus the scopes this tenant may grant.
 */
export class ApiKeyListDto {
  /** Key metadata. */
  @ApiProperty({ type: () => [ApiKeyDto] })
  items!: ApiKeyDto[];

  /**
   * Scopes accepted by `POST /api-keys`.
   *
   * Returned so a client can validate before submitting, instead of discovering
   * an invalid scope from a 409 after a round trip.
   */
  @ApiPropertyOptional({
    example: ['projects:read', 'projects:write', 'users:read', 'users:write', 'audit:read', 'admin:*'],
    isArray: true,
  })
  grantableScopes!: string[];
}
