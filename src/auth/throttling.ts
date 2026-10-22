import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { isInternalRoute } from '../common/decorators/internal-route.decorator';

/**
 * Rate limiting policy (BN-REQ-SEC-004).
 *
 * Two named throttlers:
 *
 *  * `default` — the per-IP budget every route shares.
 *  * `auth` — a much tighter budget, applied **only** to the credential
 *    endpoints marked with {@link AuthThrottle} (sign-in, refresh, invitation
 *    acceptance). `@nestjs/throttler` applies every named throttler to every
 *    route unless it is skipped, so `auth` opts routes *in* through `skipIf`
 *    rather than every other route having to opt out.
 *
 * Health probes are exempt from both, whatever decorators the health
 * controller carries: an orchestrator polling readiness must never be told 429.
 * So are internal routes (`POST /internal/tick`, BN-TASK-016): their only caller
 * is Cloud Scheduler, authenticated by its own guard.
 *
 * Deliberately free of runtime imports from `@nestjs/throttler`, so the policy
 * is unit testable without loading the package (CommonJS that requires the
 * ESM-only `@nestjs/common`).
 */

/** Metadata key marking a route as subject to the `auth` throttler. */
export const AUTH_THROTTLE_KEY = 'throttle:auth';

/** Name of the credential-endpoint throttler. */
export const AUTH_THROTTLER = 'auth';

/** Name of the global throttler. */
export const DEFAULT_THROTTLER = 'default';

/**
 * Subjects a credential endpoint to the `auth` throttler.
 *
 * @returns A method or class decorator.
 */
export const AuthThrottle = (): MethodDecorator & ClassDecorator => SetMetadata(AUTH_THROTTLE_KEY, true);

/**
 * Tests whether a request path is a health probe.
 *
 * Health is mounted outside the API prefix (`/health`, `/health/live`,
 * `/health/ready`), so the match is anchored at the root.
 *
 * @param url Request URL, possibly with a query string.
 * @returns `true` for a health probe.
 */
export function isHealthRequest(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return path === '/health' || path.startsWith('/health/');
}

/**
 * Reads the request URL from an execution context.
 *
 * @param context Execution context.
 * @returns The original URL, or `undefined` outside HTTP.
 */
function urlOf(context: ExecutionContext): string | undefined {
  const request = context.switchToHttp().getRequest<{ originalUrl?: string; url?: string } | undefined>();
  return request?.originalUrl ?? request?.url;
}

/**
 * Tests whether the route opted into the `auth` throttler.
 *
 * @param context Execution context.
 * @returns `true` when the handler or its controller carries {@link AuthThrottle}.
 */
export function isAuthThrottled(context: ExecutionContext): boolean {
  return (
    Reflect.getMetadata(AUTH_THROTTLE_KEY, context.getHandler()) === true ||
    Reflect.getMetadata(AUTH_THROTTLE_KEY, context.getClass()) === true
  );
}

/**
 * Tests whether a request is exempt from every throttler: a health probe, or a
 * route marked internal.
 *
 * @param context Execution context.
 * @returns `true` when no throttler applies.
 */
export function isThrottleExempt(context: ExecutionContext): boolean {
  return (
    isHealthRequest(urlOf(context)) ||
    isInternalRoute(context.getHandler()) ||
    isInternalRoute(context.getClass())
  );
}

/** Budgets and storage for {@link buildThrottlerOptions}. */
export interface ThrottlerPolicyInput {
  readonly defaultLimit: number;
  readonly defaultTtlMs: number;
  readonly authLimit: number;
  readonly authTtlMs: number;
  /** Shared storage (Redis) for multi-instance deployments; in-memory when absent. */
  readonly storage?: ThrottlerStorage;
}

/**
 * Builds the `ThrottlerModule` options.
 *
 * `skipIf` is set on each named throttler because the library uses a named
 * throttler's own `skipIf` *instead of* the common one, not in addition to it.
 *
 * @param input Budgets and optional shared storage.
 * @returns Module options.
 */
export function buildThrottlerOptions(input: ThrottlerPolicyInput): {
  throttlers: ThrottlerOptions[];
  storage?: ThrottlerStorage;
} {
  return {
    throttlers: [
      {
        name: DEFAULT_THROTTLER,
        ttl: input.defaultTtlMs,
        limit: input.defaultLimit,
        skipIf: (context) => isThrottleExempt(context),
      },
      {
        name: AUTH_THROTTLER,
        ttl: input.authTtlMs,
        limit: input.authLimit,
        skipIf: (context) => isThrottleExempt(context) || !isAuthThrottled(context),
      },
    ],
    ...(input.storage ? { storage: input.storage } : {}),
  };
}
