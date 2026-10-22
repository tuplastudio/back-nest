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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthThrottle } from '../auth/throttling';
import { Public } from '../common/decorators/public.decorator';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentPrincipal, CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthorizationException } from '../common/errors/app.exception';
import { ProjectsService } from './projects.service';
import { TenantUsersService } from './tenant-users.service';
import { TenantGuard } from '../tenancy/tenant.guard';
import { ProjectStatus } from '../generated/tenant-plane/enums';
import {
  AcceptInvitationDto,
  CreatedUserDto,
  CreateProjectDto,
  CreateUserDto,
  ListUsersQueryDto,
  TenantRefreshTokenDto,
  TenantSignInDto,
  TenantTokenResponseDto,
  UpdateProjectDto,
  UserDto,
  UserListDto,
} from './dto/tenant-api.dto';
import type { Principal, TenantContext } from '../tenancy/tenant-context.interface';

/**
 * Authentication endpoints scoped to one tenant.
 *
 * `POST /t/auth/sign-in` resolves the tenant from the request first (header or
 * subdomain), then authenticates against that tenant's schema. There is no way
 * to sign in as a member of tenant A while addressed as tenant B: the lookup
 * only ever touches the resolved schema.
 */
@ApiTags('tenant authentication')
@Controller('t/auth')
export class TenantAuthController {
  /**
   * @param users Tenant member service.
   */
  constructor(private readonly users: TenantUsersService) {}

  /**
   * Signs a tenant member in.
   *
   * @param dto Credentials.
   * @returns The issued token pair.
   */
  @Public()
  @UseGuards(TenantGuard)
  @AuthThrottle()
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in as a tenant member',
    description:
      'Authenticates against the tenant resolved from X-Tenant-Id, X-Tenant-Slug or the request subdomain. The e-mail is matched through a keyed blind index, so no plaintext e-mail is queried.',
  })
  @ApiOkResponse({ type: () => TenantTokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials, inactive account or lockout.' })
  @ApiForbiddenResponse({ description: 'The tenant is not active, or could not be resolved.' })
  async signIn(@Body() dto: TenantSignInDto): Promise<TenantTokenResponseDto> {
    const result = await this.users.signIn(dto.email, dto.password);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.max(0, Math.round((result.accessTokenExpiresAt - Date.now()) / 1000)),
      userId: result.userId,
      emailMasked: result.emailMasked,
      displayName: result.displayName,
      role: result.role,
    };
  }

  /**
   * Rotates a tenant member's session.
   *
   * @param dto Refresh token payload.
   * @returns A new token pair.
   */
  @Public()
  @UseGuards(TenantGuard)
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh a tenant session',
    description:
      'Rotates the refresh token. Presenting an already-rotated token revokes the entire rotation family.',
  })
  @ApiOkResponse({ type: () => TenantTokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'The token is unknown, expired or already revoked.' })
  async refresh(@Body() dto: TenantRefreshTokenDto): Promise<TenantTokenResponseDto> {
    const result = await this.users.refresh(dto.refreshToken);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.max(0, Math.round((result.accessTokenExpiresAt - Date.now()) / 1000)),
      userId: result.userId,
      emailMasked: result.emailMasked,
      displayName: result.displayName,
      role: result.role,
    };
  }

  /**
   * Accepts a member invitation and sets the member's password.
   *
   * @param dto Invitation token and the chosen password.
   */
  @Public()
  @UseGuards(TenantGuard)
  @AuthThrottle()
  @Post('accept-invitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Accept a member invitation',
    description:
      'Activates an INVITED member with the password they choose. The token is single use: once accepted the member is no longer INVITED and the token is refused.',
  })
  @ApiBadRequestResponse({ description: 'The invitation is invalid, expired or already used.' })
  async acceptInvitation(@Body() dto: AcceptInvitationDto): Promise<void> {
    await this.users.acceptInvitation(dto.token, dto.password);
  }
}

/**
 * Tenant member management.
 *
 * Reading the member list requires the `users:read` scope for API keys; member
 * sessions are authorised by their tenant role at the service layer.
 */
@ApiTags('tenant users')
@ApiBearerAuth('bearer-jwt')
@ApiSecurity('tenant-slug')
@Controller('t/users')
@RequirePermissions('users:read', 'users:write')
@UseGuards(TenantGuard)
export class TenantUsersController {
  /**
   * @param users Tenant member service.
   */
  constructor(private readonly users: TenantUsersService) {}

  /**
   * Lists the tenant's members.
   *
   * @param tenant Current tenant.
   * @param query Filtering and pagination.
   * @returns A page of members.
   */
  @Get()
  @RequireScopes('users:read')
  @RequirePermissions('users:read')
  @ApiOperation({
    summary: 'List tenant members',
    description: 'Members of the current tenant only. E-mail addresses are returned masked.',
  })
  @ApiOkResponse({ type: () => UserListDto })
  async list(
    @CurrentTenant() _tenant: TenantContext,
    @Query() query: ListUsersQueryDto,
  ): Promise<UserListDto> {
    const page = await this.users.list({
      role: query.role,
      search: query.search,
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      cursor: query.cursor,
    });
    return {
      items: page.items.map((user) => ({
        id: user.id,
        emailMasked: user.emailMasked,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  /**
   * Returns the caller's own e-mail address in clear text.
   *
   * @param principal The authenticated principal.
   * @returns The decrypted address.
   */
  @Get('me/email')
  // Declared for the boot audit (BN-REQ-SEC-001): the class-level permissions
  // apply here too, so an API key must name a scope. Keys have no e-mail and are
  // refused below regardless.
  @RequireScopes('users:read')
  @ApiOperation({
    summary: "Reveal the caller's own e-mail",
    description:
      'The only endpoint that returns a plaintext e-mail, and only to the principal that owns it. Everything else returns the masked form.',
  })
  @ApiOkResponse({ schema: { type: 'object', properties: { email: { type: 'string' } } } })
  async ownEmail(@CurrentPrincipal() principal: Principal): Promise<{ email: string }> {
    if (principal.kind !== 'tenant-user') {
      throw new AuthorizationException('Only tenant members have an e-mail to reveal.');
    }
    return { email: await this.users.ownEmail(principal.id) };
  }

  /**
   * Creates a member.
   *
   * @param dto Member attributes.
   * @returns The created member.
   */
  @Post()
  @RequireScopes('users:write')
  // Method level on purpose (BN-REQ-SEC-003): the class-level any-of
  // `users:read | users:write` let a read-only VIEWER create members.
  @RequirePermissions('users:write')
  @ApiOperation({
    summary: 'Create a tenant member',
    description:
      'E-mail and phone are encrypted with AES-256-GCM before storage. Lookups use a keyed blind index, and responses expose only the masked e-mail. API keys may grant at most MEMBER and may not send a password: the member is created INVITED and the one-time invitation token is returned only in this response.',
  })
  @ApiCreatedResponse({ type: () => CreatedUserDto })
  @ApiConflictResponse({ description: 'The e-mail is already registered in this tenant.' })
  @ApiForbiddenResponse({ description: 'The caller may not grant the requested role.' })
  async create(@Body() dto: CreateUserDto): Promise<CreatedUserDto> {
    const { user, invitation } = await this.users.create({
      email: dto.email,
      phone: dto.phone,
      displayName: dto.displayName,
      password: dto.password,
      role: dto.role,
    });
    return {
      id: user.id,
      emailMasked: user.emailMasked,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      invitationToken: invitation?.token ?? null,
      invitationExpiresAt: invitation ? new Date(invitation.expiresAt) : null,
    };
  }

  /**
   * Returns one member.
   *
   * @param id Member UUID.
   * @returns The member.
   */
  @Get(':id')
  @RequireScopes('users:read')
  @RequirePermissions('users:read')
  @ApiOperation({ summary: 'Get a tenant member' })
  @ApiOkResponse({ type: () => UserDto })
  @ApiNotFoundResponse({ description: 'No member with that id exists in this tenant.' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserDto> {
    const user = await this.users.findById(id);
    return {
      id: user.id,
      emailMasked: user.emailMasked,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}

/**
 * Example tenant-scoped resource endpoints.
 *
 * Deliberately small: this is a reference for the conventions the base
 * recommends rather than a business feature.
 */
@ApiTags('tenant projects')
@ApiBearerAuth('bearer-jwt')
@ApiSecurity('tenant-slug')
@Controller('t/projects')
@UseGuards(TenantGuard)
export class TenantProjectsController {
  /**
   * @param projects Project service.
   */
  constructor(private readonly projects: ProjectsService) {}

  /**
   * Lists projects in the current tenant.
   *
   * @param query Filter and pagination parameters.
   * @returns A page of projects.
   */
  @Get()
  @RequireScopes('projects:read')
  @RequirePermissions('projects:read')
  @ApiOperation({
    summary: 'List projects',
    description: 'Soft-deleted projects are excluded. Pagination is cursor based.',
  })
  @ApiOkResponse({ description: 'A page of projects.' })
  async list(
    @Query('status') status: ProjectStatus | undefined,
    @Query('ownerId') ownerId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ items: readonly unknown[]; nextCursor: string | null; total: number }> {
    return this.projects.list({
      status,
      ownerId,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  /**
   * Creates a project.
   *
   * @param dto Project attributes.
   * @returns The created project.
   */
  @Post()
  @RequireScopes('projects:write')
  @RequirePermissions('projects:write')
  @ApiOperation({
    summary: 'Create a project',
    description: 'Member sessions own what they create; API keys must pass `ownerId`.',
  })
  @ApiCreatedResponse({ description: 'The created project.' })
  @ApiConflictResponse({ description: 'The slug is already used in this tenant.' })
  create(@Body() dto: CreateProjectDto) {
    return this.projects.create({
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      status: dto.status,
      metadata: dto.metadata,
      ownerId: dto.ownerId,
    });
  }

  /**
   * Returns one project.
   *
   * @param id Project UUID.
   * @returns The project.
   */
  @Get(':id')
  @RequireScopes('projects:read')
  @RequirePermissions('projects:read')
  @ApiOperation({ summary: 'Get a project' })
  @ApiOkResponse({ description: 'The project.' })
  @ApiNotFoundResponse({ description: 'No project with that id exists in this tenant.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.projects.findById(id);
  }

  /**
   * Updates a project.
   *
   * @param id Project UUID.
   * @param dto Fields to change.
   * @returns The updated project.
   */
  @Patch(':id')
  @RequireScopes('projects:write')
  @RequirePermissions('projects:write')
  @ApiOperation({
    summary: 'Update a project',
    description: 'Supply `expectedVersion` for optimistic concurrency control; a mismatch returns 409.',
  })
  @ApiOkResponse({ description: 'The updated project.' })
  @ApiConflictResponse({ description: 'Concurrent modification detected.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(id, {
      name: dto.name,
      description: dto.description,
      status: dto.status,
      metadata: dto.metadata,
      expectedVersion: dto.expectedVersion,
    });
  }

  /**
   * Soft-deletes a project.
   *
   * @param id Project UUID.
   * @returns The deleted project.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('projects:write')
  @RequirePermissions('projects:write')
  @ApiOperation({
    summary: 'Delete a project',
    description: 'Soft delete: the row is retained with `deletedAt` set.',
  })
  @ApiOkResponse({ description: 'The deleted project.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projects.remove(id);
  }
}
