import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MemberRole, MemberStatus, ProjectStatus } from '../../generated/tenant-plane/enums';

/**
 * Roles a member-creation request is allowed to grant.
 *
 * `OWNER` is deliberately absent: the tenant's top role is not grantable through
 * `POST /t/users`, and {@link CreateUserDto.role} enforces it at the edge so the
 * contract in its own documentation is a real validator rather than an OpenAPI
 * annotation. `TenantUsersService.create` re-checks it at the service layer.
 */
export const GRANTABLE_MEMBER_ROLES = [MemberRole.ADMIN, MemberRole.MEMBER, MemberRole.VIEWER] as const;

/**
 * Tenant member credentials.
 */
export class TenantSignInDto {
  /** Registered e-mail address. Encrypted before storage, never logged. */
  @ApiProperty({ example: 'ada@acme.com' })
  @IsEmail({}, { message: 'A valid e-mail address is required.' })
  @MaxLength(320)
  email!: string;

  /** Account password. */
  @ApiProperty({ format: 'password', example: 'correct-horse-battery-staple' })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}

/**
 * Refresh token payload for tenant sessions.
 */
export class TenantRefreshTokenDto {
  /** The refresh token issued previously. */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/**
 * Successful tenant authentication result.
 */
export class TenantTokenResponseDto {
  /** Short-lived JWT access token. */
  @ApiProperty()
  accessToken!: string;

  /** Rotating refresh token. */
  @ApiProperty()
  refreshToken!: string;

  /** Always `Bearer`. */
  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  /** Access token lifetime in seconds. */
  @ApiProperty({ example: 900 })
  expiresIn!: number;

  /** Member id. */
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  /** Masked e-mail. The full address is only available through `GET /t/users/me/email`. */
  @ApiProperty({ example: 'a***a@acme.com' })
  emailMasked!: string;

  /** Display name. */
  @ApiProperty({ example: 'Ada Lovelace' })
  displayName!: string;

  /** Tenant-scoped role. */
  @ApiProperty({ enum: MemberRole })
  role!: MemberRole;
}

/**
 * Payload for creating a tenant member.
 */
export class CreateUserDto {
  /** E-mail address; encrypted at rest. */
  @ApiProperty({ example: 'grace@acme.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /** Optional phone number in E.164 format; encrypted at rest. */
  @ApiPropertyOptional({ example: '+5215512345678' })
  @IsOptional()
  @Matches(/^\+?[1-9]\d{6,14}$/, { message: 'phone must be in E.164 format' })
  phone?: string;

  /** Display name. */
  @ApiProperty({ example: 'Grace Hopper', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  /**
   * Initial password.
   *
   * Omit for SSO-only accounts; the member is then created as `INVITED` with
   * no password hash and an invitation token. API keys must omit it: a key
   * sending a password is refused with 422 (BN-REQ-SEC-002).
   */
  @ApiPropertyOptional({ format: 'password', minLength: 8 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password?: string;

  /** Tenant-scoped role. Members cannot grant `OWNER`. */
  @ApiPropertyOptional({ enum: GRANTABLE_MEMBER_ROLES, default: MemberRole.MEMBER })
  @IsOptional()
  @IsIn(GRANTABLE_MEMBER_ROLES, {
    message: 'role must be one of ADMIN, MEMBER or VIEWER; OWNER is not grantable through this endpoint',
  })
  role?: MemberRole;
}

/**
 * Tenant member projection.
 *
 * The e-mail appears as {@link CreateUserDto.email}'s masked form; the plaintext
 * is retrievable only by the member themselves.
 */
export class UserDto {
  /** Member UUID. */
  @ApiProperty({ format: 'uuid' })
  id!: string;

  /** Masked e-mail address. */
  @ApiProperty({ example: 'g***e@acme.com' })
  emailMasked!: string;

  /** Display name. */
  @ApiProperty({ example: 'Grace Hopper' })
  displayName!: string;

  /** Tenant-scoped role. */
  @ApiProperty({ enum: MemberRole })
  role!: MemberRole;

  /** Lifecycle status. */
  @ApiProperty({ enum: MemberStatus })
  status!: MemberStatus;

  /** Whether the e-mail has been verified. */
  @ApiProperty()
  emailVerifiedAt!: Date | null;

  /** Last successful sign-in. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt!: Date | null;

  /** Creation timestamp. */
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * A member as returned by `POST /t/users`.
 *
 * Carries the invitation token when the member was created `INVITED` (always the
 * case for API keys). The token is shown only in this response.
 */
export class CreatedUserDto extends UserDto {
  /** One-time invitation token; `null` when the member was created active. */
  @ApiProperty({ type: String, nullable: true })
  invitationToken!: string | null;

  /** Invitation expiry; `null` when there is no invitation. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  invitationExpiresAt!: Date | null;
}

/**
 * Payload for accepting a member invitation.
 */
export class AcceptInvitationDto {
  /** Invitation token returned when the member was created. */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  token!: string;

  /** Password the invited member chooses. */
  @ApiProperty({ format: 'password', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}

/**
 * Paginated member list.
 */
export class UserListDto {
  /** Members on this page. */
  @ApiProperty({ type: () => [UserDto] })
  items!: UserDto[];

  /** Cursor for the next page, or `null`. */
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  /** Total matching members. */
  @ApiProperty({ example: 12 })
  total!: number;
}

/**
 * Query parameters for listing members.
 */
export class ListUsersQueryDto {
  /** Filter by role. */
  @ApiPropertyOptional({ enum: MemberRole })
  @IsOptional()
  @IsEnum(MemberRole)
  role?: MemberRole;

  /** Case-insensitive match on display name. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  /** Page size, 1-100. */
  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @IsString()
  limit?: string;

  /** Cursor returned by a previous page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

/**
 * Payload for creating a project.
 */
export class CreateProjectDto {
  /** Display name. */
  @ApiProperty({ example: 'Q1 Platform Migration', maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  /** URL-safe identifier, unique within the tenant. */
  @ApiProperty({ example: 'q1-platform-migration', maxLength: 160 })
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/, {
    message: 'slug must be lowercase alphanumeric with internal hyphens',
  })
  slug!: string;

  /** Optional description. */
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Initial status. */
  @ApiPropertyOptional({ enum: ProjectStatus, default: ProjectStatus.DRAFT })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  /** PII-free structured attributes. */
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /** Owning member. Required when authenticating with an API key. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Required when the caller is an API key.' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

/**
 * Payload for updating a project.
 */
export class UpdateProjectDto {
  /** New display name. */
  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  /** New description. */
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** New status. */
  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  /** Replacement metadata. */
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /**
   * Version the caller last observed.
   *
   * Supplying it turns the update into a compare-and-swap: a mismatch is
   * rejected with 409 instead of overwriting a concurrent change.
   */
  @ApiPropertyOptional({ example: 3, description: 'Optimistic concurrency guard. 409 on mismatch.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
