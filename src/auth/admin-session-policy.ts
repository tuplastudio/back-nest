import { HttpStatus, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { SCOPES_KEY } from '../common/decorators/scopes.decorator';

/**
 * Session rules for platform administrators (BN-REQ-SEC-006, BN-REQ-SEC-008).
 *
 *  * **MFA.** When `MFA_REQUIRED_FOR_ADMINS` is on, or the admin enrolled
 *    anyway, every route needs an access token minted after a TOTP or recovery
 *    code (`mfa` claim). Unenrolled or unverified sessions only reach the MFA
 *    endpoints. `403 MFA_REQUIRED`.
 *  * **Password rotation.** While `mustChangePassword` is set, only the
 *    password change endpoint (and the MFA endpoints it may depend on) answers.
 *    `403 PASSWORD_CHANGE_REQUIRED`.
 *  * **Step-up.** A platform admin writing payments of a tenant — always a
 *    cross-tenant act for a platform principal — must have verified MFA within
 *    the last 5 minutes. `403 STEP_UP_REQUIRED`. The same holds for minting,
 *    rotating or revoking an API key and for changing outbound webhooks: a key
 *    or an endpoint is a standing channel to the same payments, so a stale
 *    session must not be able to open one and use it instead.
 */

/** Maximum age of the MFA verification for a step-up route, in seconds. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

/** Route reachable by a session that still owes MFA (enroll/confirm/verify). */
export const ALLOW_MFA_PENDING_KEY = 'auth:allowMfaPending';

/** Route reachable while a password change is pending. */
export const ALLOW_PASSWORD_CHANGE_KEY = 'auth:allowPasswordChangePending';

/** Route that requires a fresh MFA from a platform admin. */
export const STEP_UP_KEY = 'auth:stepUp';

/** @returns Decorator letting a session that still owes MFA through. */
export const AllowMfaPending = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_MFA_PENDING_KEY, true);

/** @returns Decorator letting a session with a pending password change through. */
export const AllowPasswordChangePending = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);

/** @returns Decorator requiring a recent MFA from platform admins. */
export const RequireStepUp = (): MethodDecorator & ClassDecorator => SetMetadata(STEP_UP_KEY, true);

/** Inputs of {@link evaluateAdminSession}. */
export interface AdminSessionFacts {
  readonly mustChangePassword: boolean;
  readonly mfaEnrolled: boolean;
  /** Epoch seconds of the MFA verification carried by the token, if any. */
  readonly mfaAt: number | undefined;
  readonly mfaRequired: boolean;
  readonly nowSeconds: number;
  readonly allowMfaPending: boolean;
  readonly allowPasswordChange: boolean;
  readonly stepUpRequired: boolean;
}

/**
 * Decides whether a platform admin session may use a route.
 *
 * @param facts Session and route facts.
 * @returns `null` when allowed, otherwise the exception to throw.
 */
export function evaluateAdminSession(facts: AdminSessionFacts): AppException | null {
  const mfaApplies = facts.mfaRequired || facts.mfaEnrolled;
  if (facts.allowMfaPending) {
    return null;
  }
  if (mfaApplies && (!facts.mfaEnrolled || facts.mfaAt === undefined)) {
    return new AppException(
      facts.mfaEnrolled
        ? 'Verify your second factor at POST /auth/mfa/verify before using this endpoint.'
        : 'Platform administrators must enrol a second factor: POST /auth/mfa/enroll, then /auth/mfa/confirm.',
      'MFA_REQUIRED',
      HttpStatus.FORBIDDEN,
      { enrolled: facts.mfaEnrolled },
    );
  }
  if (facts.mustChangePassword && !facts.allowPasswordChange) {
    return new AppException(
      'A password change is required: POST /auth/change-password.',
      'PASSWORD_CHANGE_REQUIRED',
      HttpStatus.FORBIDDEN,
    );
  }
  if (
    facts.stepUpRequired &&
    mfaApplies &&
    (facts.mfaAt === undefined || facts.nowSeconds - facts.mfaAt > STEP_UP_MAX_AGE_SECONDS)
  ) {
    return new AppException(
      'This operation needs a second-factor verification from the last 5 minutes: POST /auth/mfa/verify.',
      'STEP_UP_REQUIRED',
      HttpStatus.FORBIDDEN,
      { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS },
    );
  }
  return null;
}

/**
 * Whether a route needs step-up for a platform admin.
 *
 * Explicit `@RequireStepUp()`, or any non-read request to a route that requires
 * a `payments:*` or `webhooks:*` scope, or `admin:*` (API key management) — the
 * payment write surface and the credentials that reach it — so those
 * controllers need no extra decorator.
 *
 * @param context Execution context.
 * @returns `true` when step-up applies.
 */
export function routeRequiresStepUp(context: ExecutionContext): boolean {
  const handler = context.getHandler();
  const controller = context.getClass();
  if (
    Reflect.getMetadata(STEP_UP_KEY, handler) === true ||
    Reflect.getMetadata(STEP_UP_KEY, controller) === true
  ) {
    return true;
  }
  const method = context.switchToHttp().getRequest<{ method?: string } | undefined>()?.method?.toUpperCase();
  if (method === undefined || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return false;
  }
  const scopes = (Reflect.getMetadata(SCOPES_KEY, handler) ?? Reflect.getMetadata(SCOPES_KEY, controller)) as
    string[] | undefined;
  return (
    scopes?.some(
      (scope) => scope.startsWith('payments:') || scope.startsWith('webhooks:') || scope === 'admin:*',
    ) ?? false
  );
}

/**
 * Reads a boolean route flag from handler or controller.
 *
 * @param context Execution context.
 * @param key Metadata key.
 * @returns The flag.
 */
export function routeFlag(context: ExecutionContext, key: string): boolean {
  return (
    Reflect.getMetadata(key, context.getHandler()) === true ||
    Reflect.getMetadata(key, context.getClass()) === true
  );
}
