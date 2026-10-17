import { HttpStatus } from '@nestjs/common';

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
   */
  constructor(
    message: string,
    readonly code: string,
    readonly status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: Record<string, unknown>,
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
  constructor(provider: string, message?: string, details: Record<string, unknown> = {}) {
    super(
      message ?? `The ${provider} provider could not be reached.`,
      'UPSTREAM_PROVIDER_ERROR',
      HttpStatus.BAD_GATEWAY,
      { provider, ...details },
    );
  }
}

/** A domain invariant was violated, e.g. deleting the last owner. */
export class DomainException extends AppException {
  constructor(message: string, code = 'DOMAIN_VIOLATION', details?: Record<string, unknown>) {
    super(message, code, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}
