import { Injectable, Scope, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../common/decorators/permissions.decorator';
import { API_KEY_ONLY_KEY } from '../common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { AuthorizationException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import { AuthorizationService } from './authorization.service';

/**
 * Enforces the permissions a route declares.
 *
 * Registered as an `APP_GUARD` so it applies everywhere, but it only judges
 * routes that actually declare a requirement. Authentication is already
 * deny-by-default; a route with no permission metadata simply keeps the coarse
 * controls that already apply to it (`@Roles` for the platform plane, API-key
 * scopes for machine principals), which keeps this an additive layer rather than
 * a behavioural change to every existing route.
 *
 * API keys are not judged here. Their authority is the scope set, enforced by
 * `ApiKeyScopesGuard`; a key holds no roles and asking the catalogue about one
 * would report the wrong reason for a denial.
 */
// Request-scoped on purpose, like `AuthGuard` and `ApiKeyScopesGuard`. Nest runs
// singleton global guards before request-scoped ones regardless of registration
// order, so a singleton here would be judged before authentication had attached
// a principal.
@Injectable({ scope: Scope.REQUEST })
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly requestContext: RequestContextService,
  ) {}

  /**
   * @param context Execution context.
   * @returns `true` when the request may proceed.
   * @throws {AuthorizationException} When the principal lacks a required permission.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const anyOf = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    const allOf = this.reflector.getAllAndOverride<string[]>(ALL_PERMISSIONS_KEY, targets);
    if (!anyOf?.length && !allOf?.length) {
      return true;
    }

    const principal = this.requestContext.principal;
    if (principal === null || principal === undefined) {
      // A route that requires permissions but carries no principal is either
      // public or API-key-only, where permissions are not the authority.
      //
      // Anything else means authentication did not run, and that must NOT be read
      // as "allowed": treating a missing principal as permission would make every
      // permission check pass, so this denies instead.
      const isUnauthenticatedRoute =
        this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true ||
        this.reflector.getAllAndOverride<boolean>(API_KEY_ONLY_KEY, targets) === true;
      if (isUnauthenticatedRoute) {
        return true;
      }
      throw new AuthorizationException('Authentication required.');
    }
    if (principal.kind === 'api-key') {
      // A key's authority is its scope set, judged by `ApiKeyScopesGuard`.
      return true;
    }

    const authority = await this.authorization.resolve(principal);

    if (allOf?.length) {
      const missing = allOf.filter((permission) => !authority.permissions.has(permission));
      if (missing.length > 0) {
        throw new AuthorizationException(`Missing required permission(s): ${missing.join(', ')}.`);
      }
    }

    if (anyOf?.length) {
      const held = anyOf.filter((permission) => authority.permissions.has(permission));
      if (held.length === 0) {
        throw new AuthorizationException(`This endpoint requires one of: ${anyOf.join(', ')}.`);
      }
    }

    return true;
  }
}
