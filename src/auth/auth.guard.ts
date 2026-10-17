import { ExecutionContext, Injectable, Scope, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyScopesGuard } from './api-key-scopes.guard';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { API_KEY_ONLY_KEY, ROLES_KEY } from '../common/decorators/roles.decorator';
import { ApiKeyService } from '../api-keys/api-key.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { TokenService } from './token.service';
import { RequestContextService } from '../tenancy/request-context.service';
import type { Principal } from '../tenancy/tenant-context.interface';
import { ApiKeyStatus } from '../generated/control-plane/enums';
import { AuthorizationException, InvalidApiKeyException } from '../common/errors/app.exception';

/** Shape of an API key bearer token. */
export const API_KEY_PATTERN = /^([a-z0-9]{2,12})_([A-Za-z0-9]{8,32})_([A-Za-z0-9_-]{43})$/;

/** Platform roles `@Roles()` accepts. */
type PlatformRole = 'OWNER' | 'ADMIN' | 'AUDITOR';

/**
 * Authenticates every request.
 *
 * Registered globally in `AppModule`, which makes authentication
 * deny-by-default: a new controller cannot accidentally ship unauthenticated,
 * because the only way to opt out is the explicit `@Public()` decorator.
 *
 * Supported credentials, attempted in order:
 *
 *  1. **API key** — `Authorization: Bearer mtb_live_xxx_yyy`. Scoped to exactly
 *     one tenant. The tenant must already have been resolved by middleware: a
 *     key never selects its own tenant, which removes a whole class of
 *     cross-tenant replay attacks.
 *  2. **Access token** — `Authorization: Bearer <JWT>`, issued to a platform
 *     administrator or a tenant member. The signature is verified, then the
 *     principal is re-read from the database so a suspension takes effect on the
 *     next request rather than when the token happens to expire.
 *
 * Failure responses are uniform. An expired token, a revoked key and a key
 * belonging to another tenant all produce the same 401, so the endpoint cannot
 * be used as an oracle.
 */
@Injectable({ scope: Scope.REQUEST })
export class AuthGuard {
  /**
   * @param reflector Reads `@Public`, `@Roles` and `@ApiKeyOnly` metadata.
   * @param requestContext Request-scoped context holder.
   * @param prisma Control-plane Prisma service.
   * @param tenantPrisma Tenant data plane factory.
   * @param apiKeys API key issuing and verification service.
   * @param tokens Access/refresh token service.
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: RequestContextService,
    private readonly prisma: ControlPlanePrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly apiKeys: ApiKeyService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * @param context Execution context.
   * @returns `true` when the request may proceed.
   * @throws {UnauthorizedException} When authentication fails on a protected route.
   * @throws {AuthorizationException} When the role is not permitted.
   * @throws {InvalidApiKeyException} When an API key fails verification.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
    const apiKeyOnly = this.reflector.getAllAndOverride<boolean>(API_KEY_ONLY_KEY, targets) === true;
    const requiredRoles = this.reflector.getAllAndOverride<PlatformRole[]>(ROLES_KEY, targets);

    const token = readBearerToken(context);

    if (apiKeyOnly && !token) {
      throw new InvalidApiKeyException('This endpoint requires an API key.');
    }

    const principal = await this.resolvePrincipal(token, apiKeyOnly);

    if (!principal) {
      if (isPublic) {
        return true;
      }
      throw new UnauthorizedException('Authentication required.');
    }

    this.assertRole(principal, requiredRoles);
    this.requestContext.patch({ principal });
    // Also attached to the request itself. Guards share one AsyncLocalStorage,
    // but depending on its propagation between sibling guard invocations is the
    // kind of implicit coupling that lets an authorization check silently see no
    // principal; the request travels with the pipeline.
    const request = context.switchToHttp().getRequest<{ principal?: Principal }>();
    if (request !== undefined && request !== null) {
      request.principal = principal;
    }

    return true;
  }

  /**
   * Turns a bearer token into a principal.
   *
   * @param token Bearer token, or `null`.
   * @param apiKeyOnly Whether the route refuses session tokens.
   * @returns The principal, or `null` when no credential was supplied.
   */
  private async resolvePrincipal(token: string | null, apiKeyOnly: boolean): Promise<Principal | null> {
    if (!token) {
      return null;
    }
    if (API_KEY_PATTERN.test(token)) {
      return this.authenticateApiKey(token);
    }
    if (apiKeyOnly) {
      throw new InvalidApiKeyException('This endpoint requires an API key, not a session token.');
    }
    return this.authenticateAccessToken(token);
  }

  /**
   * Verifies an API key and records its usage.
   *
   * @param token The raw API key.
   * @returns The API key principal.
   * @throws {InvalidApiKeyException} When the key is malformed, unknown, revoked,
   * expired, or presented against the wrong tenant.
   */
  private async authenticateApiKey(token: string): Promise<Principal> {
    const match = API_KEY_PATTERN.exec(token);
    if (!match) {
      throw new InvalidApiKeyException('Malformed API key.');
    }
    const keyPrefix = `${match[1]}_${match[2]}`;
    const secret = match[3];

    const tenant = this.requestContext.tenant;
    if (!tenant) {
      throw new InvalidApiKeyException(
        'API keys are tenant scoped: send X-Tenant-Id, X-Tenant-Slug or use a tenant subdomain.',
      );
    }

    const record = await this.prisma.client.apiKey.findUnique({
      where: { tenantId_prefix: { tenantId: tenant.id, prefix: keyPrefix } },
      select: {
        id: true,
        name: true,
        tenantId: true,
        secretHash: true,
        scopes: true,
        status: true,
        expiresAt: true,
        tenant: { select: { status: true } },
      },
    });

    if (!record) {
      // Burn equivalent CPU so an unknown prefix is indistinguishable from a
      // wrong secret.
      await this.apiKeys.equaliseTiming(secret);
      throw new InvalidApiKeyException();
    }

    if (!(await this.apiKeys.verifySecret(record.secretHash, secret))) {
      throw new InvalidApiKeyException();
    }

    // Status is only reported to a caller who actually holds the key.
    if (record.status !== ApiKeyStatus.ACTIVE) {
      throw new InvalidApiKeyException(`This API key is ${record.status.toLowerCase()}.`);
    }
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      throw new InvalidApiKeyException('This API key has expired.');
    }
    if (record.tenant.status !== 'ACTIVE') {
      throw new InvalidApiKeyException('The owning tenant is not active.');
    }

    void this.apiKeys.touchUsage(record.id, this.requestContext.get().ipHash).catch(() => undefined);

    return {
      kind: 'api-key',
      id: record.id,
      name: record.name,
      tenantId: record.tenantId,
      scopes: record.scopes,
    };
  }

  /**
   * Verifies a JWT access token and re-reads the principal.
   *
   * @param token The raw JWT.
   * @returns The principal, or `null` when the token is unusable.
   */
  private async authenticateAccessToken(token: string): Promise<Principal | null> {
    let payload;
    try {
      payload = this.tokens.verifyAccessToken(token);
    } catch {
      // Expired and tampered tokens are indistinguishable to the caller.
      return null;
    }

    if (payload.kind === 'platform-admin') {
      const admin = await this.prisma.client.platformAdmin.findUnique({
        where: { id: payload.sub },
        select: { id: true, displayName: true, role: true, status: true },
      });
      if (!admin || admin.status !== 'ACTIVE') {
        return null;
      }
      return {
        kind: 'platform-admin',
        id: admin.id,
        displayName: admin.displayName,
        role: admin.role,
        tenantId: payload.tid ?? this.requestContext.tenant?.id ?? null,
      };
    }

    // Tenant members live in a per-tenant schema, so the tenant must be known
    // and must match the scope the token was minted for.
    const tenant = this.requestContext.tenant;
    if (!tenant || (payload.tid && payload.tid !== tenant.id)) {
      return null;
    }

    // Read through the tenant-scoped transaction: the member row lives behind
    // row-level security, so an unwrapped client would not see it and every
    // member request would authenticate as 401.
    const user = await this.tenantPrisma.forTenantTransaction(tenant.schemaName, (client) =>
      client.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, displayName: true, role: true, status: true, deletedAt: true },
      }),
    );

    if (!user || user.status !== 'ACTIVE' || user.deletedAt !== null) {
      return null;
    }

    return {
      kind: 'tenant-user',
      id: user.id,
      displayName: user.displayName,
      role: user.role,
      tenantId: tenant.id,
    };
  }

  /**
   * Enforces `@Roles(...)` on the route.
   *
   * This is the platform-administration boundary. The tenant and api-key role
   * vocabularies overlap with the platform one — both spell `OWNER` and
   * `ADMIN` — so the principal kind is checked before the role string is. A
   * tenant-scoped role must never satisfy a platform `@Roles(...)` route.
   *
   * Tenant roles are enforced separately, by service-level ownership and
   * membership checks, because a tenant's own role vocabulary is domain specific.
   *
   * @param principal The authenticated principal.
   * @param requiredRoles Roles permitted by the route metadata, if any.
   * @throws {AuthorizationException} When the principal kind or the role is not permitted.
   */
  private assertRole(principal: Principal, requiredRoles: PlatformRole[] | undefined): void {
    if (!requiredRoles || requiredRoles.length === 0) {
      return;
    }
    if (principal.kind !== 'platform-admin') {
      throw new AuthorizationException(
        `Principal kind "${principal.kind}" is not permitted on this endpoint. Required: ${requiredRoles.join(' or ')}.`,
      );
    }
    if (!requiredRoles.includes(principal.role)) {
      throw new AuthorizationException(
        `Role "${principal.role}" is not permitted on this endpoint. Required: ${requiredRoles.join(' or ')}.`,
      );
    }
  }
}

/**
 * Extracts the bearer token from the `Authorization` header.
 *
 * @param context Execution context.
 * @returns The token, or `null` when the header is absent or not a bearer scheme.
 */
export function readBearerToken(context: ExecutionContext): string | null {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
  const header = request.headers['authorization'];
  if (!header) {
    return null;
  }
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') {
    return null;
  }
  const token = rest.join(' ');
  return token.length > 0 ? token : null;
}

/**
 * Combined decorator applying {@link AuthGuard} then
 * {@link ApiKeyScopesGuard}.
 *
 * Provided for controllers that opt out of the global guards (for example in a
 * test harness); the application itself registers both globally.
 *
 * @returns A class/method decorator applying the guards in order.
 */
export const Authenticated = (): MethodDecorator & ClassDecorator => UseGuards(AuthGuard, ApiKeyScopesGuard);

/**
 * Alias kept for readability in controllers that need the raw context service.
 *
 * @param context Execution context.
 * @returns The request context holder.
 */
export function requestContextOf(context: ExecutionContext): RequestContextService {
  return context.switchToHttp().getRequest<{ contextRef: RequestContextService }>().contextRef;
}
