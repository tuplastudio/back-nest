import { HttpStatus } from '@nestjs/common';

/** Statuses a client may retry as they are, without changing the request. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.REQUEST_TIMEOUT,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
  HttpStatus.GATEWAY_TIMEOUT,
]);

/**
 * Reports whether a status means "try again later" rather than "this request is wrong".
 *
 * @param status HTTP status.
 * @returns `true` for 408, 429, 503 and 504.
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Base class for every error this application raises deliberately.
 *
 * Carrying an HTTP status on the exception lets {@link AllExceptionsFilter}
 * translate it into a response without a chain of `instanceof` checks, and the
 * `code` field gives clients a stable, machine-readable discriminator that does
 * not change when the human-readable message does.
 */
export class AppException extends Error {
  /**
   * @param message Human readable, safe to return to the client.
   * @param code Stable machine-readable error code.
   * @param status HTTP status to respond with.
   * @param details Optional structured, non-sensitive context.
   * @param retryable Whether repeating the same request may succeed. Defaults
   *   from the status: 408, 429, 503 and 504 are retryable, everything else is not.
   */
  constructor(
    message: string,
    readonly code: string,
    readonly status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: Record<string, unknown>,
    readonly retryable: boolean = isRetryableStatus(status),
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request payload failed validation. */
export class ValidationException extends AppException {
  constructor(message = 'Request validation failed.', details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', HttpStatus.BAD_REQUEST, details);
  }
}

/** The caller could not be authenticated. */
export class AuthenticationException extends AppException {
  constructor(message = 'Authentication required.', code = 'UNAUTHENTICATED') {
    super(message, code, HttpStatus.UNAUTHORIZED);
  }
}

/** The caller is known but not permitted. */
export class AuthorizationException extends AppException {
  constructor(
    message = 'You do not have permission to perform this action.',
    details?: Record<string, unknown>,
  ) {
    super(message, 'FORBIDDEN', HttpStatus.FORBIDDEN, details);
  }
}

/** A resource does not exist, or the caller may not know that it does. */
export class NotFoundException extends AppException {
  constructor(resource = 'Resource', identifier?: string) {
    super(
      identifier ? `${resource} "${identifier}" was not found.` : `${resource} was not found.`,
      'NOT_FOUND',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** The request conflicts with the current state of the resource. */
export class ConflictException extends AppException {
  constructor(message = 'The request conflicts with the current state.', details?: Record<string, unknown>) {
    super(message, 'CONFLICT', HttpStatus.CONFLICT, details);
  }
}

/**
 * The order is in a state that does not allow the operation (BN-REQ-PAY-003).
 *
 * Distinct from the generic `CONFLICT`: the order itself, not a concurrent
 * request, is what refuses. `details.status` carries the status; when a previous
 * charge turned out to be paid, `details.order` carries the order.
 */
export class OrderStateConflictException extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ORDER_STATE_CONFLICT', HttpStatus.CONFLICT, details);
  }
}

/**
 * An `Idempotency-Key` was reused with a different request body (BN-REQ-IDM-001).
 *
 * The key names one request; reusing it for another is a client defect, so
 * this is a 422 and repeating it as is never succeeds.
 */
export class IdempotencyKeyReusedException extends AppException {
  constructor() {
    super(
      'This Idempotency-Key was already used with a different request body.',
      'IDEMPOTENCY_KEY_REUSED',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * The first request with this `Idempotency-Key` has not finished (BN-REQ-IDM-003).
 *
 * Retryable: once the first one finishes, the same request gets its stored
 * response. The filter sends `Retry-After` from {@link retryAfterSeconds}.
 */
export class IdempotencyInProgressException extends AppException {
  constructor(readonly retryAfterSeconds = 2) {
    super(
      'A request with this Idempotency-Key is still in progress.',
      'IDEMPOTENCY_IN_PROGRESS',
      HttpStatus.CONFLICT,
      { retryAfterSeconds },
      true,
    );
  }
}

/**
 * Netpay carried the operation out but recording it locally failed (BN-REQ-IDM-004).
 *
 * The result is kept as a pending provider result and the order keeps its claim;
 * reconciliation applies it. Not retryable: repeating the operation could move
 * the money twice. Read the order later instead.
 */
export class ProviderResultPendingException extends AppException {
  constructor(operation: string) {
    super(
      'The provider carried out the operation, but recording it failed; it will be applied by reconciliation. Read the order later instead of retrying.',
      'PROVIDER_RESULT_PENDING',
      HttpStatus.INTERNAL_SERVER_ERROR,
      { operation },
      false,
    );
  }
}

/** The caller exceeded a rate limit or attempt budget. */
export class TooManyRequestsException extends AppException {
  /**
   * @param message Human readable explanation.
   * @param retryAfterSeconds Value for the `Retry-After` header.
   */
  constructor(
    message = 'Too many requests.',
    readonly retryAfterSeconds = 60,
  ) {
    super(message, 'TOO_MANY_REQUESTS', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
  }
}

/** The account is temporarily locked after repeated failed sign-ins. */
export class AccountLockedException extends AppException {
  constructor(retryAfterSeconds: number) {
    super(
      'Account is temporarily locked after too many failed attempts.',
      'ACCOUNT_LOCKED',
      HttpStatus.LOCKED,
      { retryAfterSeconds },
    );
  }
}

/** Credentials were correct in shape but wrong. */
export class InvalidCredentialsException extends AppException {
  constructor() {
    // Deliberately identical for "unknown user" and "wrong password" so the
    // endpoint cannot be used to enumerate accounts.
    super('Invalid credentials.', 'INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED);
  }
}

/** No tenant could be resolved for the request. */
export class TenantRequiredException extends AppException {
  constructor(message = 'A tenant must be specified via X-Tenant-Id, X-Tenant-Slug or a tenant subdomain.') {
    super(message, 'TENANT_REQUIRED', HttpStatus.BAD_REQUEST);
  }
}

/** The resolved tenant exists but is not in a state that serves traffic. */
export class TenantUnavailableException extends AppException {
  /**
   * @param slug Tenant slug.
   * @param status Current tenant status.
   */
  constructor(slug: string, status: string) {
    super(
      `Tenant "${slug}" is not available (status: ${status}).`,
      'TENANT_UNAVAILABLE',
      HttpStatus.FORBIDDEN,
      {
        status,
      },
    );
  }
}

/** The supplied API key is missing, malformed, expired or revoked. */
export class InvalidApiKeyException extends AppException {
  constructor(message = 'Invalid API key.') {
    super(message, 'INVALID_API_KEY', HttpStatus.UNAUTHORIZED);
  }
}

/** The API key is valid but lacks the scope required by the route. */
export class MissingScopeException extends AppException {
  /**
   * @param required Scope required by the route.
   * @param granted Scopes granted to the key.
   */
  constructor(
    readonly required: string,
    readonly granted: readonly string[],
  ) {
    super(`This API key is missing the "${required}" scope.`, 'MISSING_SCOPE', HttpStatus.FORBIDDEN, {
      required,
      granted: [...granted],
    });
  }
}

/** A token was replayed, indicating a stolen refresh token. */
export class TokenReuseDetectedException extends AppException {
  constructor() {
    super(
      'This refresh token was already used. All sessions in the family have been revoked.',
      'TOKEN_REUSE_DETECTED',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

/** A raw SQL statement or identifier failed the safety checks. */
export class UnsafeSqlException extends AppException {
  /**
   * @param reason Machine readable rejection reason.
   * @param message Safe explanation for the caller.
   */
  constructor(reason: string, message: string) {
    super(message, `UNSAFE_SQL_${reason.replaceAll('_', '')}`, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

/**
 * An upstream provider could not be reached or refused the request.
 *
 * Distinct from a 500 on purpose: the request was well formed and the caller is
 * not at fault, so this is a gateway failure rather than a server defect.
 */
export class UpstreamProviderException extends AppException {
  /**
   * @param provider Provider name, e.g. `Netpay`.
   * @param message Safe explanation for the caller.
   * @param details Non-sensitive context.
   * @param code Stable code; see the subclasses.
   * @param status HTTP status.
   */
  constructor(
    provider: string,
    message?: string,
    details: Record<string, unknown> = {},
    code = 'UPSTREAM_PROVIDER_ERROR',
    status: HttpStatus = HttpStatus.BAD_GATEWAY,
  ) {
    super(message ?? `The ${provider} provider could not be reached.`, code, status, {
      provider,
      ...details,
    });
  }
}

/**
 * The provider gave no definitive answer: a timeout, a dropped connection, a 5xx or
 * an unreadable body (BN-REQ-PAY-011).
 *
 * The operation may or may not have happened at the provider, so this is a **504**
 * and `retryable`, and whoever holds an operation claim must keep it: the order is
 * left for reconciliation, never reopened for a second attempt that could charge or
 * refund twice.
 */
export class ProviderOutcomeUnknownException extends UpstreamProviderException {
  constructor(provider: string, message?: string, details: Record<string, unknown> = {}) {
    super(
      provider,
      message ?? `The ${provider} provider did not give a definitive answer; the outcome is unknown.`,
      details,
      'PROVIDER_OUTCOME_UNKNOWN',
      HttpStatus.GATEWAY_TIMEOUT,
    );
  }
}

/**
 * The provider explicitly refused the request (a 4xx). Nothing happened there, so
 * this is a **502**, not retryable as is, and an operation claim may be released.
 */
export class ProviderDeclinedException extends UpstreamProviderException {
  constructor(provider: string, message?: string, details: Record<string, unknown> = {}) {
    super(
      provider,
      message ?? `The ${provider} provider refused the request.`,
      details,
      'PROVIDER_DECLINED',
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/**
 * Reports whether an error means the provider outcome is unknown.
 *
 * Structural on the code so it also recognises subclasses defined next to a client.
 *
 * @param error Caught value.
 * @returns `true` for `PROVIDER_OUTCOME_UNKNOWN`.
 */
export function isProviderOutcomeUnknown(error: unknown): boolean {
  return error instanceof AppException && error.code === 'PROVIDER_OUTCOME_UNKNOWN';
}

/** A domain invariant was violated, e.g. deleting the last owner. */
export class DomainException extends AppException {
  constructor(message: string, code = 'DOMAIN_VIOLATION', details?: Record<string, unknown>) {
    super(message, code, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

/**
 * Provider credentials failed the check against the provider (BN-TASK-025).
 *
 * `CREDENTIALS_ENVIRONMENT_MISMATCH` when the key works in the other environment
 * (a live key saved as sandbox, or the reverse), `CREDENTIALS_INVALID` otherwise.
 */
export class CredentialsRejectedException extends AppException {
  constructor(code: 'CREDENTIALS_ENVIRONMENT_MISMATCH' | 'CREDENTIALS_INVALID', message: string) {
    super(message, code, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/**
 * The order's currency is not one the tenant is enabled for (BN-REQ-PAY-008).
 * `details`: `{ currency, allowed }`.
 */
export class CurrencyNotEnabledException extends AppException {
  constructor(currency: string, allowed: readonly string[]) {
    super(
      `This tenant is not enabled to charge in ${currency}.`,
      'CURRENCY_NOT_ENABLED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { currency, allowed: [...allowed] },
    );
  }
}

/**
 * A hosted return URL is not `https`, or its origin is not in the tenant's
 * `allowedReturnOrigins` (BN-REQ-PAY-007). `details`: `{ field, origin }`.
 */
export class ReturnUrlNotAllowedException extends AppException {
  constructor(field: string, origin: string | null, message: string) {
    super(message, 'RETURN_URL_NOT_ALLOWED', HttpStatus.UNPROCESSABLE_ENTITY, { field, origin });
  }
}
