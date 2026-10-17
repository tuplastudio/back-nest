import { SetMetadata, applyDecorators } from '@nestjs/common';
import { DeclaredRbac } from './roles.decorator';

/** Metadata key holding the permissions a route accepts (any-of). */
export const PERMISSIONS_KEY = 'auth:permissions';

/** Metadata key holding the permissions a route requires (all-of). */
export const ALL_PERMISSIONS_KEY = 'auth:allPermissions';

/**
 * Requires the caller to hold at least one of `permissions`.
 *
 * Permissions are the fine-grained half of authorization. A role bundles them,
 * a user holds roles, and a caller's effective permissions are the union of the
 * permissions of every role it holds — see {@link AuthorizationService}.
 *
 * This composes with, rather than replaces, the coarse platform gate
 * (`@Roles`) and with API-key scopes, which govern machine principals. A route
 * may use all three; each answers a different question.
 *
 * @param permissions Accepted permissions; the caller needs at least one.
 * @returns A method and class decorator carrying the requirement.
 */
export const RequirePermissions = (...permissions: readonly string[]): MethodDecorator & ClassDecorator => {
  if (permissions.length === 0) {
    throw new Error(
      '@RequirePermissions() requires at least one permission. Omitting them removes authorization ' +
        'from the route instead of denying it.',
    );
  }
  return applyDecorators(SetMetadata(PERMISSIONS_KEY, [...permissions]), DeclaredRbac());
};

/**
 * Requires the caller to hold every one of `permissions`.
 *
 * @param permissions Permissions that must all be held.
 * @returns A method and class decorator carrying the requirement.
 */
export const RequireAllPermissions = (
  ...permissions: readonly string[]
): MethodDecorator & ClassDecorator => {
  if (permissions.length === 0) {
    throw new Error('@RequireAllPermissions() requires at least one permission.');
  }
  return applyDecorators(SetMetadata(ALL_PERMISSIONS_KEY, [...permissions]), DeclaredRbac());
};

/**
 * Grants a permission without a guard, for documenting intent on routes that are
 * already covered by a coarser control.
 *
 * Intended for audit tooling and documentation; it is deliberately NOT read by
 * {@link PermissionsGuard} and must never be used to bypass a permission check.
 *
 * @param _permissions Permissions the route is understood to require.
 * @returns A no-op decorator.
 */
export const GrantsPermissions = (..._permissions: readonly string[]): MethodDecorator => {
  throw new Error(
    'GrantsPermissions() is documentation-only and must not be used on a route. ' +
      'Use @RequirePermissions() or @RequireAllPermissions() to actually enforce authority.',
  );
};

/**
 * Combines several authorization decorators into one.
 *
 * @param decorators Decorators to apply together.
 * @returns A combined decorator.
 */
export const Secured = (
  ...decorators: (MethodDecorator & ClassDecorator)[]
): MethodDecorator & ClassDecorator => applyDecorators(...decorators);
