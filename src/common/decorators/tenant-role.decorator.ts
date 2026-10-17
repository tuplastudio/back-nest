import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MemberRole } from '../../generated/tenant-plane/enums';
import { AuthorizationException } from '../errors/app.exception';
import { DeclaredRbac } from './roles.decorator';
import { RequestContextService } from '../../tenancy/request-context.service';

/**
 * Ordering used to compare tenant roles.
 *
 * Shared so the guard and the services cannot disagree about who outranks whom.
 * `OWNER` is retained because a tenant's OWNER is the highest tenant-side role
 * and must satisfy every minimum.
 */
export const TENANT_ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  [MemberRole.VIEWER]: 0,
  [MemberRole.MEMBER]: 1,
  [MemberRole.ADMIN]: 2,
  [MemberRole.OWNER]: 3,
};

export const MINIMUM_TENANT_ROLE = 'auth:minimumTenantRole';

/** Metadata key holding the minimum platform role required on a route. */
export const MINIMUM_PLATFORM_ROLE = 'auth:minimumPlatformRole';

/**
 * Ordering used to compare platform roles.
 *
 * Parallel to {@link TENANT_ROLE_RANK} and exhaustive over the platform role
 * vocabulary, so no stored role can rank `undefined` and slip past a comparison.
 * `AUDITOR` is read-only by definition and satisfies no minimum above `VIEWER`.
 */
export const PLATFORM_ROLE_RANK: Readonly<Record<'OWNER' | 'ADMIN' | 'AUDITOR', number>> = {
  AUDITOR: 0,
  ADMIN: 1,
  OWNER: 2,
};

/**
 * Requires a platform administrator's role to be at least `role`.
 *
 * `@Roles` cannot be used for this. `AuthGuard.assertRole` refuses every
 * principal whose kind is not `platform-admin` whenever `@Roles` metadata is
 * present, so applying it to a controller that also admits tenant members would
 * lock out the tenant `ADMIN` that `@MinimumTenantRole` deliberately admits.
 * This decorator is the counterpart of {@link MinimumTenantRole} for the
 * platform plane, and is enforced by the same guard so the two can never drift.
 *
 * @param role Minimum platform role that may reach the route.
 * @returns A method and class decorator carrying the minimum.
 */
export const MinimumPlatformRole = (role: 'OWNER' | 'ADMIN'): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(MINIMUM_PLATFORM_ROLE, role), DeclaredRbac());

/**
 * Requires the caller's tenant role to be at least `role`.
 *
 * `ApiKeyScopesGuard` only speaks for API keys: it returns true for every
 * principal whose kind is not `api-key`, on the stated contract that tenant
 * members are authorised by their tenant role "at the service layer". For routes
 * that issue or rotate credentials there was no such check anywhere, so a
 * read-only `VIEWER` could mint a key and receive its clear-text secret. This
 * guard is the missing decision point.
 *
 * Platform administrators and API keys are not tenant-scoped principals and pass
 * through; their own authorization is handled by `@Roles` and by scopes.
 *
 * @param role Minimum tenant role that may reach the route.
 * @returns A method and class decorator carrying the minimum.
 */
export const MinimumTenantRole = (role: MemberRole): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(MINIMUM_TENANT_ROLE, role), DeclaredRbac());

/**
 * Enforces {@link MinimumTenantRole} for tenant-member sessions and
 * {@link MinimumPlatformRole} for platform administrators.
 *
 * @see MinimumTenantRole
 * @see MinimumPlatformRole
 */
@Injectable()
export class TenantRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: RequestContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MemberRole>(MINIMUM_TENANT_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const minimumPlatform = this.reflector.getAllAndOverride<'OWNER' | 'ADMIN'>(MINIMUM_PLATFORM_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined && minimumPlatform === undefined) {
      return true;
    }
    const principal = this.requestContext.principal;
    // Unauthenticated is AuthGuard's decision.
    if (!principal) {
      return true;
    }
    if (principal.kind === 'platform-admin') {
      // A platform administrator is not a tenant-scoped principal, so
      // `@MinimumTenantRole` never judges them. A controller that mutates tenant
      // state can still declare a platform minimum: without it, platform-role
      // authorisation is opt-in and a read-only AUDITOR would reach any route
      // whose only role declaration was a tenant minimum.
      if (minimumPlatform !== undefined) {
        const rank = PLATFORM_ROLE_RANK[principal.role] ?? 0;
        if (rank < PLATFORM_ROLE_RANK[minimumPlatform]) {
          throw new AuthorizationException(
            `Platform role "${principal.role}" is below the "${minimumPlatform}" required on this endpoint.`,
          );
        }
      }
      return true;
    }
    // API keys are not tenant-scoped principals and carry their own scope
    // authorization; tenant members are judged against the tenant minimum.
    if (principal.kind !== 'tenant-user') {
      return true;
    }
    if (required !== undefined && TENANT_ROLE_RANK[principal.role] < TENANT_ROLE_RANK[required]) {
      throw new AuthorizationException(
        `Tenant role "${principal.role}" is below the "${required}" required on this endpoint.`,
      );
    }
    return true;
  }
}
