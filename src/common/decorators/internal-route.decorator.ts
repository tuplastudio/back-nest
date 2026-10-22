/**
 * Metadata key marking a route as internal: called by the platform itself (Cloud
 * Scheduler), never by a tenant or a person.
 *
 * An internal route is outside the tenant/principal model entirely, so the global
 * `AuthGuard` does not try to read its bearer token as an API key or a session
 * (a Google OIDC ID token would fail there), the throttlers skip it, and the route
 * must carry a guard of its own that authenticates the caller. `RbacAuditService`
 * enforces that last part at boot. The decorator that sets it, together with that
 * guard, is `InternalOnly()` in `src/internal/internal-only.decorator.ts`.
 */
export const INTERNAL_ROUTE_KEY = 'auth:internal';

/**
 * Reads the internal flag from a handler or controller.
 *
 * @param target Route handler or controller class.
 * @returns `true` when the route is internal.
 */
export function isInternalRoute(target: unknown): boolean {
  if (typeof target !== 'function' && (typeof target !== 'object' || target === null)) {
    return false;
  }
  return Reflect.getMetadata(INTERNAL_ROUTE_KEY, target) === true;
}
