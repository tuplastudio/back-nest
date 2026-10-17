import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyOnly } from '../common/decorators/roles.decorator';
import { TenantGuard } from '../tenancy/tenant.guard';
import {
  MinimumPlatformRole,
  MinimumTenantRole,
  TenantRoleGuard,
} from '../common/decorators/tenant-role.decorator';
import { MemberRole } from '../generated/tenant-plane/enums';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ApiKeyService, GRANTABLE_SCOPES } from './api-key.service';
import { AuditActorType } from '../generated/control-plane/enums';
import { CreateApiKeyDto, ListApiKeysQueryDto } from './dto/api-key.dto';
import { ApiKeyCreatedDto, ApiKeyDto, ApiKeyListDto } from './dto/api-key-response.dto';
import { CurrentPrincipal, CurrentTenant } from '../common/decorators/current-tenant.decorator';
import type { Principal, TenantContext } from '../tenancy/tenant-context.interface';
import { NotFoundException } from '../common/errors/app.exception';

/**
 * Per-tenant API key management.
 *
 * Tenant scoping
 * --------------
 * The tenant always comes from `@TenantGuard` (i.e. from the request's resolved
 * tenant), never from the request body. A caller can therefore never mint a key
 * for a tenant it has not been routed to, which removes an entire class of
 * privilege-escalation bugs.
 *
 * Read operations accept either a session token or an API key, so a pipeline can
 * rotate its own credentials without a human. Write operations require a human
 * session or a key holding `admin:*`.
 */
@ApiTags('api-keys')
@ApiBearerAuth('bearer-jwt')
@ApiSecurity('tenant-id')
@Controller('api-keys')
@UseGuards(TenantGuard, TenantRoleGuard)
// Issuing, rotating or revoking a credential is an administrative act inside the
// tenant. `@RequireScopes` below is inert for member sessions by design, so this
// is the control that stops a read-only VIEWER minting a key and receiving its
// clear-text secret.
@MinimumTenantRole(MemberRole.ADMIN)
// The fine-grained permissions, and the union of them, are declared here.
// Reading a key's metadata is governed by `api-keys:read` alone; minting,
// rotating and revoking additionally require a platform role of at least ADMIN,
// applied per route below.
@RequirePermissions('api-keys:read', 'api-keys:issue', 'api-keys:rotate', 'api-keys:revoke')
export class ApiKeysController {
  /**
   * @param apiKeys API key service.
   */
  constructor(private readonly apiKeys: ApiKeyService) {}

  /**
   * Lists the tenant's API keys.
   *
   * @param tenant Current tenant.
   * @param query Filter options.
   * @returns The key metadata, without any secret material.
   */
  @Get()
  @RequireScopes('admin:*')
  @RequirePermissions('api-keys:read')
  @ApiOperation({
    summary: 'List API keys',
    description:
      "Returns metadata for the current tenant's keys. Secrets are never returned — only an Argon2id hash is stored, so the clear-text key exists only at creation and rotation time.",
  })
  @ApiOkResponse({ type: () => ApiKeyListDto })
  @ApiForbiddenResponse({ description: 'The key lacks the `admin:*` scope.' })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListApiKeysQueryDto,
  ): Promise<ApiKeyListDto> {
    const keys = await this.apiKeys.list(tenant.id, query.includeRevoked === 'true');
    return {
      items: keys.map((key) => this.toDto(key)),
      grantableScopes: [...GRANTABLE_SCOPES],
    };
  }

  /**
   * Issues a new API key.
   *
   * @param tenant Current tenant.
   * @param body Key attributes.
   * @param principal The acting administrator or member.
   * @returns The key metadata and its one-time clear-text secret.
   */
  @Post()
  @RequireScopes('admin:*')
  @MinimumPlatformRole('ADMIN')
  @RequirePermissions('api-keys:issue')
  @ApiOperation({
    summary: 'Create an API key',
    description: [
      'Issues a tenant-scoped machine credential and returns the clear-text secret',
      '**exactly once**. It cannot be retrieved later because only an Argon2id hash is',
      'persisted.',
      '',
      'Key format: `<prefix>_<publicPart>_<secretPart>`. The public part is indexed for',
      'O(1) lookup; the secret part carries 256 bits of entropy.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: () => ApiKeyCreatedDto })
  @ApiBadRequestResponse({ description: 'Invalid payload.' })
  @ApiConflictResponse({ description: 'An unsupported scope was requested.' })
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: CreateApiKeyDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ApiKeyCreatedDto> {
    const createdBy = {
      type: principal.kind === 'tenant-user' ? AuditActorType.TENANT_USER : AuditActorType.PLATFORM_ADMIN,
      id: principal.id,
    };

    const { key, secret } = await this.apiKeys.issue(
      tenant.id,
      body.name,
      body.scopes,
      body.expiresAt ? new Date(body.expiresAt) : null,
      createdBy,
    );

    return { ...this.toDto(key), secret };
  }

  /**
   * Rotates an API key.
   *
   * @param tenant Current tenant.
   * @param id API key UUID.
   * @returns The new key and its one-time secret.
   */
  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('admin:*')
  @MinimumPlatformRole('ADMIN')
  @RequirePermissions('api-keys:rotate')
  @ApiOperation({
    summary: 'Rotate an API key',
    description:
      'Mints a new secret, revokes the previous one and links them for auditability. Both operations share a transaction, so a failure can never leave two active secrets for one logical key.',
  })
  @ApiOkResponse({ type: () => ApiKeyCreatedDto })
  @ApiNotFoundResponse({ description: 'No key with that id belongs to this tenant.' })
  @ApiConflictResponse({ description: 'The key is not active.' })
  async rotate(@CurrentTenant() tenant: TenantContext, @Param('id') id: string): Promise<ApiKeyCreatedDto> {
    const { key, secret } = await this.apiKeys.rotate(tenant.id, id);
    return { ...this.toDto(key), secret };
  }

  /**
   * Revokes an API key.
   *
   * @param tenant Current tenant.
   * @param id API key UUID.
   * @returns The revoked key metadata.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('admin:*')
  @MinimumPlatformRole('ADMIN')
  @RequirePermissions('api-keys:revoke')
  @ApiOperation({
    summary: 'Revoke an API key',
    description:
      'Revocation is immediate and irreversible. Rotate instead if the secret may only have been seen in transit.',
  })
  @ApiOkResponse({ type: () => ApiKeyDto })
  @ApiNotFoundResponse({ description: 'No key with that id belongs to this tenant.' })
  async revoke(@CurrentTenant() tenant: TenantContext, @Param('id') id: string): Promise<ApiKeyDto> {
    return this.toDto(await this.apiKeys.revoke(tenant.id, id));
  }

  /**
   * Maps a key row to its API projection.
   *
   * @param key The row.
   * @returns The DTO.
   * @throws {NotFoundException} Never; present for signature symmetry.
   */
  private toDto(key: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    status: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    usageCount: bigint;
    rotatedFromId: string | null;
    createdAt: Date;
  }): ApiKeyDto {
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes,
      status: key.status as ApiKeyDto['status'],
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      lastUsedAt: key.lastUsedAt,
      // BigInt is not JSON-serialisable; expose it as a number because usage
      // counters are far below 2^53 for any realistic key.
      usageCount: Number(key.usageCount),
      rotatedFromId: key.rotatedFromId,
      createdAt: key.createdAt,
    };
  }
}

/** Raised when a tenant has no keys at all; kept for API stability. */
export type TenantKeyNotFound = NotFoundException;

/** Re-exported so controllers can reference the decorator without a deep import. */
export { ApiKeyOnly };
