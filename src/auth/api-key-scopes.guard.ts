import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Scope } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPES_KEY } from '../common/decorators/scopes.decorator';
import { MissingScopeException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';

/**
 * Enforces API key scopes declared with `@RequireScopes(...)`.
 *
 * Scope model
 * -----------
 * Scopes are `resource:verb` strings, e.g. `projects:read`, `projects:write`.
 * Three rules keep the model predictable:
 *
 *  * A wildcard `*` grants everything. Convenient for CI pipelines, discouraged
 *    in production because it defeats the purpose of scoping.
 *  * A resource wildcard (`projects:*`) grants every verb on that resource.
 *  * `admin:*` is reserved for cross-resource operations and is only ever
 *    granted to platform administrators, never to a tenant key.
 *
 * Human sessions are not scope checked here: an API key arriving without the
 * required scope is a programming error, whereas a member's permissions come
 * from their tenant role, which services check against the resource being
 * touched.
 */
/**
 * Request scoped because it reads {@link RequestContextService}, which is
 * itself request scoped; registering it globally is what makes scope enforcement
 * apply to every route without a decorator.
 */
@Injectable({ scope: Scope.REQUEST })
export class ApiKeyScopesGuard implements CanActivate {
  /**
   * @param reflector Reads `@RequireScopes` metadata.
   * @param requestContext Request-scoped context holder.
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: RequestContextService,
  ) {}

  /**
   * @param context Execution context.
   * @returns `true` when the principal satisfies the required scopes.
   * @throws {MissingScopeException} When a key lacks a required scope.
   * @throws {ForbiddenException} When a non-API-key principal hits a scoped route.
   */
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const principal = this.requestContext.principal;
    if (!principal) {
      throw new ForbiddenException('This endpoint requires an authenticated principal.');
    }

    // Tenant members are authorised by their tenant role at the service layer,
    // which can see the specific resource being touched.
    if (principal.kind !== 'api-key') {
      return true;
    }

    const granted = principal.scopes;
    const missing = required.filter((scope) => !this.satisfies(granted, scope));

    if (missing.length > 0) {
      throw new MissingScopeException(missing[0], granted);
    }
    return true;
  }

  /**
   * Tests whether a granted set satisfies a required scope.
   *
   * @param granted Scopes on the key.
   * @param required Scope the route requires.
   * @returns `true` when satisfied.
   */
  private satisfies(granted: readonly string[], required: string): boolean {
    if (granted.includes('*')) {
      return true;
    }
    if (granted.includes(required)) {
      return true;
    }
    const [resource] = required.split(':');
    return resource !== undefined && granted.includes(`${resource}:*`);
  }
}
