import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
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
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { OptionalTenant } from '../common/decorators/current-tenant.decorator';
import {
  CreateTenantDto,
  ListTenantsQueryDto,
  PurgeTenantDto,
  SuspendTenantDto,
  UpdateTenantDto,
} from './dto/tenant.dto';
import {
  MigrateTenantDto,
  PurgeResultDto,
  ResolvedTenantDto,
  TenantDetailDto,
  TenantListDto,
  TenantStatsDto,
  TenantSummaryDto,
} from './dto/tenant-response.dto';

import { TenantsService } from './tenants.service';
import type { TenantContext } from './tenant-context.interface';

/**
 * Tenant administration endpoints — the control plane.
 *
 * These routes operate on tenants themselves rather than on data inside a tenant.
 * Every route is restricted to platform administrators via `@Roles`, and the
 * acting administrator is taken from the request context (never from the body),
 * so the audit trail always records a real principal.
 *
 * Note that these routes do **not** require `@TenantGuard`: administering tenants
 * is exactly the operation performed when no tenant is selected.
 */
@ApiTags('tenants')
@ApiBearerAuth('bearer-jwt')
@Controller('tenants')
export class TenantsController {
  /**
   * @param tenants Tenant administration service.
   */
  constructor(private readonly tenants: TenantsService) {}

  /**
   * Reports which tenant this request resolved to.
   *
   * The first thing to check when tenant-scoped data looks wrong, since routing
   * bugs (a missing header, an unexpected subdomain) are the usual cause.
   */
  @Get('context')
  @ApiOperation({
    summary: 'Resolved tenant for this request',
    description:
      'Returns the tenant resolved from X-Tenant-Id, X-Tenant-Slug or the request subdomain, and which of those won. Returns `null` on control-plane routes that do not target a tenant.',
  })
  @ApiOkResponse({ description: 'The resolved tenant and the header that resolved it.' })
  context(@OptionalTenant() tenant: TenantContext | null, @Req() request: Request): ResolvedTenantDto {
    return {
      tenant: tenant
        ? {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            status: tenant.status,
            plan: tenant.plan,
            timezone: tenant.timezone,
            activeApiKeyCount: 0,
            createdAt: new Date(tenant.resolvedAt),
          }
        : null,
      resolvedBy: tenant ? this.detectSource(request) : 'none',
    };
  }

  /**
   * Lists tenants with cursor pagination.
   *
   * @param query Filter and pagination parameters.
   * @returns A page of tenant summaries.
   */
  @Get()
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @ApiOperation({
    summary: 'List tenants',
    description:
      'Tenants ordered by creation date, newest first. Soft-deleted tenants are excluded unless an explicit status filter includes them.',
  })
  @ApiOkResponse({ type: () => TenantListDto })
  async list(@Query() query: ListTenantsQueryDto): Promise<TenantListDto> {
    const page = await this.tenants.list({
      status: query.status,
      search: query.search,
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      cursor: query.cursor,
    });
    return {
      items: [...page.items] as TenantSummaryDto[],
      meta: { nextCursor: page.nextCursor, total: page.total },
    };
  }

  /**
   * Returns aggregate counts for the administration dashboard.
   */
  @Get('stats')
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @ApiOperation({
    summary: 'Tenant statistics',
    description: 'Counts of tenants by status and active API keys.',
  })
  @ApiOkResponse({ type: () => TenantStatsDto })
  stats(): Promise<TenantStatsDto> {
    return this.tenants.stats();
  }

  /**
   * Retrieves a single tenant.
   *
   * @param id Tenant UUID.
   * @returns The tenant detail.
   */
  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @ApiOperation({
    summary: 'Get a tenant',
    description: 'Returns one tenant, including the physical schema name for operator tooling.',
  })
  @ApiOkResponse({ type: () => TenantDetailDto })
  @ApiNotFoundResponse({ description: 'No tenant with that id.' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetailDto> {
    return this.tenants.findById(id);
  }

  /**
   * Creates a tenant and provisions its schema.
   *
   * @param body Tenant attributes.
   * @returns The provisioned tenant.
   */
  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({
    summary: 'Create a tenant',
    description:
      'Creates the registry row, provisions the dedicated PostgreSQL schema, applies tenant migrations and activates the tenant. If provisioning fails, the row is retained in PROVISIONING so the operation can be retried without duplicating the tenant.',
  })
  @ApiCreatedResponse({ type: () => TenantDetailDto })
  @ApiBadRequestResponse({ description: 'The slug or another field failed validation.' })
  @ApiConflictResponse({ description: 'The slug is already in use.' })
  @ApiForbiddenResponse({ description: 'The caller is not permitted to create tenants.' })
  async create(@Body() body: CreateTenantDto): Promise<TenantDetailDto> {
    return this.tenants.create({
      slug: body.slug,
      name: body.name,
      plan: body.plan,
      timezone: body.timezone,
      locale: body.locale,
      settings: body.settings,
      supportContact: body.supportContact,
    });
  }

  /**
   * Updates mutable tenant attributes.
   *
   * @param id Tenant UUID.
   * @param body Fields to change.
   * @returns The updated tenant.
   */
  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({
    summary: 'Update a tenant',
    description:
      'Slug and schema name are immutable: changing them would repoint live subdomains and cached clients at different data.',
  })
  @ApiOkResponse({ type: () => TenantDetailDto })
  @ApiNotFoundResponse({ description: 'No tenant with that id.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTenantDto): Promise<TenantDetailDto> {
    return this.tenants.update(id, {
      name: body.name,
      plan: body.plan,
      timezone: body.timezone,
      locale: body.locale,
      settings: body.settings,
      supportContact: body.supportContact,
    });
  }

  /**
   * Suspends a tenant and revokes its API keys.
   *
   * @param id Tenant UUID.
   * @param body Optional reason.
   * @returns The suspended tenant.
   */
  @Post(':id/suspend')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({
    summary: 'Suspend a tenant',
    description:
      'Blocks all tenant traffic and revokes every API key in the same operation, so integrations lose access immediately rather than at key expiry.',
  })
  @ApiOkResponse({ type: () => TenantDetailDto })
  @ApiNotFoundResponse({ description: 'No tenant with that id.' })
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() body: SuspendTenantDto): Promise<TenantDetailDto> {
    return this.tenants.suspend(id, body.reason);
  }

  /**
   * Returns a suspended or deprecated tenant to service.
   *
   * @param id Tenant UUID.
   * @returns The reactivated tenant.
   */
  @Post(':id/reactivate')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Reactivate a tenant', description: 'Returns a suspended tenant to ACTIVE.' })
  @ApiOkResponse({ type: () => TenantDetailDto })
  reactivate(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetailDto> {
    return this.tenants.reactivate(id);
  }

  /**
   * Applies pending migrations to a tenant schema.
   *
   * @param id Tenant UUID.
   * @returns Applied migration versions.
   */
  @Post(':id/migrate')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({
    summary: 'Migrate a tenant schema',
    description: "Applies tenant migrations newer than the tenant's recorded schema version. Idempotent.",
  })
  @ApiOkResponse({ type: () => MigrateTenantDto })
  async migrate(@Param('id', ParseUUIDPipe) id: string): Promise<MigrateTenantDto> {
    return { appliedVersions: await this.tenants.migrate(id) };
  }

  /**
   * Soft-deletes a tenant, retaining its data.
   *
   * @param id Tenant UUID.
   * @returns The deleted tenant.
   */
  @Delete(':id')
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Delete a tenant',
    description:
      'Soft deletion: data and schema are retained for the retention window. Use POST /tenants/:id/purge to drop the schema permanently.',
  })
  @ApiOkResponse({ type: () => TenantDetailDto })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetailDto> {
    return this.tenants.softDelete(id);
  }

  /**
   * Permanently drops a tenant's schema.
   *
   * @param id Tenant UUID.
   * @param body Confirmation payload; `confirm` must equal the tenant slug.
   * @returns A success marker.
   */
  @Post(':id/purge')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Purge a tenant schema',
    description:
      'Irreversibly drops the tenant schema and all of its data. Requires the slug as an explicit confirmation.',
  })
  @ApiOkResponse({ type: () => PurgeResultDto })
  @ApiConflictResponse({ description: 'The confirmation does not match the tenant slug.' })
  async purge(@Param('id', ParseUUIDPipe) id: string, @Body() body: PurgeTenantDto): Promise<PurgeResultDto> {
    await this.tenants.purge(id, body.confirm);
    return { purged: true };
  }

  /**
   * Determines which mechanism resolved the tenant for this request.
   *
   * @param request The incoming request.
   * @returns The resolution source.
   */
  private detectSource(request: Request): 'header-id' | 'header-slug' | 'subdomain' | 'none' {
    if (request.headers['x-tenant-id']) {
      return 'header-id';
    }
    if (request.headers['x-tenant-slug']) {
      return 'header-slug';
    }
    return 'subdomain';
  }
}

/** Re-exported for the tenant API module's convenience. */
export { TenantSummaryDto };
