import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/**
 * Metadata key marking a route as reachable without authentication.
 */
export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Exempts a route from authentication.
 *
 * Authentication is deny-by-default: {@link AuthGuard} rejects every request
 * that carries no valid credential, so each public route must opt in here.
 * Health checks and the sign-in endpoint are the only legitimate uses.
 *
 * @returns A decorator that stores the public flag as metadata.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Reads the public flag from route metadata.
 *
 * Reads it through `Reflect.getMetadata`, not as a property: Nest's
 * `SetMetadata` stores metadata via `Reflect.defineMetadata` and never assigns a
 * property, so a property read always reported `false`. Anything that needs to
 * resolve a handler-then-class override should use the `Reflector` instead; this
 * helper covers the single-target case.
 *
 * @param handler The route handler (or controller) carrying the metadata.
 * @returns `true` when the route is public.
 */
export function isPublic(handler: unknown): boolean {
  if (typeof handler !== 'function' && (typeof handler !== 'object' || handler === null)) {
    return false;
  }
  return Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
}
