import { SetMetadata, applyDecorators } from '@nestjs/common';
import { Public } from './public.decorator';

/** Metadata key holding the platform roles allowed on a route. */
export const ROLES_KEY = 'auth:roles';

/** Metadata key marking a route as reachable with an API key only. */
export const API_KEY_ONLY_KEY = 'auth:api-key-only';

/**
 * Metadata key stamped by every authorization decorator.
 *
 * Its presence is the machine-checkable statement "this route declares who may
 * call it". Authentication is already deny-by-default structurally, but
 * authorization used to be opt-in: a route carrying no role decorator was
 * treated as unrestricted, so one forgotten decorator silently removed access
 * control from an entire controller. `RbacAuditService` walks the route table at
 * boot and refuses to start when a non-public route carries no such declaration,
 * turning that regression into a startup failure instead of a silent hole.
 *
 * @see RbacAuditService
 */
export const RBAC_DECLARED_KEY = 'auth:rbacDeclared';

/**
 * Marks a route's authorization policy as explicitly declared.
 *
 * Applied by {@link Roles}, {@link ApiKeyOnly}, and {@link MinimumTenantRole} /
 * {@link MinimumPlatformRole}. Application code should not set it directly.
 *
 * @returns A class or method decorator stamping the declaration flag.
 */
export const DeclaredRbac = (): MethodDecorator & ClassDecorator => SetMetadata(RBAC_DECLARED_KEY, true);

/**
 * Reads the declaration flag from route metadata.
 *
 * Reads it through `Reflect.getMetadata`, not as a property: Nest's
 * `SetMetadata` stores metadata via `Reflect.defineMetadata` and never assigns a
 * property, so a property read would always report `false`.
 *
 * @param handler The route handler (or controller) carrying the metadata.
 * @returns `true` when an authorization decorator was applied.
 */
export function isRbacDeclared(handler: unknown): boolean {
  if (typeof handler !== 'function' && (typeof handler !== 'object' || handler === null)) {
    return false;
  }
  return Reflect.getMetadata(RBAC_DECLARED_KEY, handler) === true;
}

/**
 * Restricts a route to specific platform roles.
 *
 * ```ts
 * @Roles('OWNER', 'ADMIN')
 * @Post('tenants')
 * createTenant() {}
 * ```
 *
 * Platform roles are coarse by design: `OWNER` is the break-glass account,
 * `ADMIN` performs day-to-day operations, `AUDITOR` is read-only. Tenant-scoped
 * authorisation is enforced separately by `ApiKeyScopesGuard` and by
 * service-level ownership checks.
 *
 * @param roles Roles permitted to call the handler.
 * @returns A decorator storing the role list as metadata.
 */
export const Roles = (
  ...roles: readonly ('OWNER' | 'ADMIN' | 'AUDITOR')[]
): MethodDecorator & ClassDecorator => {
  // An empty list would strip authorization from the route instead of denying
  // it, so it is rejected where the mistake is made rather than silently
  // degrading `assertRole`'s fail-open default.
  if (roles.length === 0) {
    throw new Error(
      '@Roles() requires at least one role. Omitting the roles removes authorization ' +
        'from the route; use @Public() or @ApiKeyOnly() if the route really is unrestricted.',
    );
  }
  return applyDecorators(SetMetadata(ROLES_KEY, [...roles]), DeclaredRbac());
};

/**
 * Marks a route as reachable with a tenant API key only.
 *
 * Useful for endpoints where a human session makes no sense, such as
 * machine-to-machine callbacks. Applying it also implies `@Public()`, because
 * the API key itself is the credential.
 *
 * @returns A decorator storing the flag and marking the route public.
 */
export const ApiKeyOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(API_KEY_ONLY_KEY, true), Public(), DeclaredRbac());
