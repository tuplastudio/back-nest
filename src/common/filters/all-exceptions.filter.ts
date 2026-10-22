import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException, NotFoundException, isRetryableStatus } from '../errors/app.exception';
import { PiiRedactionService } from '../../pii/pii-redaction.service';

/**
 * Shape of every error response body produced by the API (BN-REQ-API-002).
 *
 * ```json
 * { "error": { "code": "PROVIDER_OUTCOME_UNKNOWN", "message": "…", "retryable": true, "details": {} },
 *   "requestId": "…", "timestamp": "…", "source": "application" }
 * ```
 *
 * `error.code` is the stable discriminator a client branches on; `error.retryable`
 * says whether repeating the same request may succeed. Documented codes include:
 *
 *  * `PROVIDER_OUTCOME_UNKNOWN` (504, retryable) — the provider gave no definitive
 *    answer; the operation may have happened and is left for reconciliation.
 *  * `PROVIDER_DECLINED` (502) — the provider explicitly refused the request.
 *  * `CREDENTIALS_ENVIRONMENT_MISMATCH` / `CREDENTIALS_INVALID` (422) — provider
 *    keys refused by the selected environment.
 *  * `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`, … for the rest.
 */
export interface ErrorResponseBody {
  readonly error: {
    /** Stable, machine-readable error code. */
    readonly code: string;
    /** Human readable, PII-free description. */
    readonly message: string;
    /** Whether the same request may succeed if repeated later. */
    readonly retryable: boolean;
    /** Structured, non-sensitive context such as validation failures. */
    readonly details?: Record<string, unknown>;
  };
  /** Correlation id, matching the `X-Request-Id` response header. */
  readonly requestId: string;
  /** RFC 3339 timestamp of the failure. */
  readonly timestamp: string;
  /** Which layer produced the error, for triage. */
  readonly source: 'application' | 'http' | 'prisma' | 'unexpected';
}

/** Placeholder written in place of a secret path segment or query value. */
const REDACTED = '[REDACTED]';

/**
 * Removes secrets from a request URL before it is logged (BN-REQ-SEC-005).
 *
 * The inbound webhook token is the only credential of that route and travels in the
 * path, so the segment after `/payments/webhook/` is replaced. Query values can carry
 * provider ids or tokens, so every value is replaced and only the names are kept.
 *
 * @param url Request URL as Express reports it.
 * @returns The URL safe to log.
 */
export function redactRequestUrl(url: string): string {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const safePath = path.replace(/(\/payments\/webhook\/)[^/]+/g, `$1${REDACTED}`);
  if (queryAt === -1) {
    return safePath;
  }
  const query = url
    .slice(queryAt + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? pair : `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join('&');
  return `${safePath}?${query}`;
}

/**
 * Converts every unhandled exception into a consistent, non-leaking response.
 *
 * Security properties
 * -------------------
 *  * **No stack traces or driver messages reach the client.** Internal failures
 *    are logged server-side with a correlation id and reported as a generic
 *    `Internal server error`.
 *  * **Messages are PII-scrubbed**, so an error raised while handling an e-mail
 *    address cannot echo it back into a response body.
 *  * **Unexpected errors are always `500`** with a stable code, which prevents
 *    accidental disclosure through differing status codes.
 *
 * Prisma translation is done by matching on the error *code* rather than with
 * `instanceof`, because Prisma 7 ships several copies of the error classes in a
 * multi-client project (control plane plus one tenant client), and structural
 * checks are the only reliable way to recognise them all.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** Prisma error codes that map onto a specific HTTP status. */
  private static readonly PRISMA_STATUS: Record<string, HttpStatus> = {
    P2000: HttpStatus.UNPROCESSABLE_ENTITY,
    P2002: HttpStatus.CONFLICT,
    P2003: HttpStatus.CONFLICT,
    P2025: HttpStatus.NOT_FOUND,
    P2034: HttpStatus.CONFLICT,
    P1001: HttpStatus.SERVICE_UNAVAILABLE,
    P1002: HttpStatus.SERVICE_UNAVAILABLE,
    P1008: HttpStatus.SERVICE_UNAVAILABLE,
    P1017: HttpStatus.SERVICE_UNAVAILABLE,
  };

  /** Safe, non-leaking messages per Prisma error code. */
  private static readonly PRISMA_MESSAGE: Record<string, string> = {
    P2000: 'A submitted value exceeds the maximum allowed length.',
    P2002: 'A resource with these unique attributes already exists.',
    P2003: 'A referenced resource does not exist.',
    P2025: 'The requested resource was not found.',
    P2034: 'The operation conflicted with a concurrent change. Please retry.',
  };

  /**
   * @param redaction Scrubs PII from messages before they are emitted.
   */
  constructor(private readonly redaction: PiiRedactionService) {}

  /**
   * Handles an exception thrown anywhere in the request pipeline.
   *
   * @param exception The thrown value.
   * @param host Nest execution context.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = request.id ?? 'unknown';

    const { status, body } = this.normalize(exception, requestId);
    // Never the raw URL: the webhook token and query values are secrets.
    const url = redactRequestUrl(request.originalUrl ?? request.url);

    if (status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      this.logger.error(
        `${request.method} ${url} -> ${status} [${requestId}] ${body.error.code}: ${body.error.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${url} -> ${status} [${requestId}] ${body.error.code}`);
    }

    if (body.error.code === 'NOT_FOUND' && status === Number(HttpStatus.NOT_FOUND)) {
      // A 404 on an unknown path is normal operation, not a warning.
      this.logger.debug(`No route matched ${request.method} ${url} [${requestId}]`);
    }

    const retryAfter = retryAfterOf(exception);
    if (retryAfter !== null) {
      // 429 TOO_MANY_REQUESTS and 409 IDEMPOTENCY_IN_PROGRESS say when to come back.
      response.setHeader('Retry-After', String(retryAfter));
    }
    response.status(status).json(body);
  }

  /**
   * Maps an arbitrary exception onto a status code and response body.
   *
   * @param exception The thrown value.
   * @param requestId Correlation id for this request.
   * @returns The status to send and the body to serialise.
   */
  private normalize(exception: unknown, requestId: string): { status: number; body: ErrorResponseBody } {
    const timestamp = new Date().toISOString();

    // 1. Deliberate application errors carry their own status and code.
    if (exception instanceof AppException) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: this.redaction.scrubMessage(exception.message),
            retryable: exception.retryable,
            ...(exception.details ? { details: this.redaction.scrub(exception.details) } : {}),
          },
          requestId,
          timestamp,
          source: 'application',
        },
      };
    }

    // 2. Nest/Express HTTP exceptions (validation pipe, 404 handler, ...).
    if (isHttpException(exception)) {
      const status = exception.getStatus();
      const extracted = this.extractHttpPayload(exception.getResponse(), exception.message);

      return {
        status,
        body: {
          error: {
            code: extracted.code,
            message: this.redaction.scrubMessage(extracted.message),
            retryable: isRetryableStatus(status),
            ...(extracted.details ? { details: this.redaction.scrub(extracted.details) } : {}),
          },
          requestId,
          timestamp,
          source: 'http',
        },
      };
    }

    // 3. Express body-parser rejections (payload too large, malformed JSON).
    const bodyParserError = exception as { type?: string; status?: number } | null;
    if (bodyParserError?.type === 'entity.too.large') {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        body: {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'The request body exceeds the maximum allowed size.',
            retryable: false,
          },
          requestId,
          timestamp,
          source: 'http',
        },
      };
    }
    if (typeof bodyParserError?.type === 'string' && bodyParserError.type.startsWith('entity.')) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: {
            code: 'MALFORMED_BODY',
            message: 'The request body could not be parsed.',
            retryable: false,
          },
          requestId,
          timestamp,
          source: 'http',
        },
      };
    }

    // 4. Prisma errors, matched structurally (see the class comment).
    const prismaCode = readPrismaCode(exception);
    if (prismaCode) {
      const status = AllExceptionsFilter.PRISMA_STATUS[prismaCode] ?? HttpStatus.BAD_REQUEST;
      const isClientVisible =
        status < HttpStatus.INTERNAL_SERVER_ERROR && prismaCode in AllExceptionsFilter.PRISMA_MESSAGE;

      return {
        status,
        body: {
          error: {
            code: isClientVisible ? prismaCode : 'DATABASE_ERROR',
            message: isClientVisible
              ? AllExceptionsFilter.PRISMA_MESSAGE[prismaCode]
              : 'The database rejected the request.',
            // A serialisation conflict (P2034) succeeds on a plain retry.
            retryable: prismaCode === 'P2034' || isRetryableStatus(status),
          },
          requestId,
          timestamp,
          source: 'prisma',
        },
      };
    }

    // Prisma validation / initialisation failures.
    const name = exception instanceof Error ? exception.name : '';
    if (name === 'PrismaClientValidationError') {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: { code: 'INVALID_QUERY', message: 'The database query was malformed.', retryable: false },
          requestId,
          timestamp,
          source: 'prisma',
        },
      };
    }
    if (name === 'PrismaClientInitializationError') {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: {
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: 'The database is currently unavailable. Please retry shortly.',
            retryable: true,
          },
          requestId,
          timestamp,
          source: 'prisma',
        },
      };
    }

    // 5. Anything else is an internal defect. Say nothing beyond the code.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred. The incident has been logged.',
          retryable: false,
        },
        requestId,
        timestamp,
        source: 'unexpected',
      },
    };
  }

  /**
   * Extracts a code and message from an `HttpException` payload.
   *
   * @param payload The payload returned by `HttpException#getResponse`.
   * @param fallback Message to use when the payload carries none.
   * @returns Normalised error code, message and details.
   */
  private extractHttpPayload(
    payload: string | object,
    fallback: string,
  ): { code: string; message: string; details?: Record<string, unknown> } {
    if (typeof payload === 'string') {
      return { code: 'HTTP_ERROR', message: payload };
    }

    const record = payload as Record<string, unknown>;
    const message = record['message'];
    const error = record['error'];

    return {
      code: typeof error === 'string' ? error.toUpperCase().replaceAll(' ', '_') : 'HTTP_ERROR',
      message: Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : fallback,
      // class-validator attaches per-field failures here.
      ...(Array.isArray(message) ? { details: { violations: message as string[] } } : {}),
    };
  }
}

/**
 * Seconds a client should wait before retrying, when the exception says.
 *
 * @param exception The thrown value.
 * @returns A positive whole number of seconds, or `null`.
 */
export function retryAfterOf(exception: unknown): number | null {
  if (!(exception instanceof AppException)) {
    return null;
  }
  const value = (exception as AppException & { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Structural check for a Nest `HttpException`.
 *
 * Avoids importing the class so the filter works even when several copies of
 * `@nestjs/common` end up in the dependency tree.
 *
 * @param exception Candidate value.
 * @returns `true` when the value exposes `getStatus` and `getResponse`.
 */
function isHttpException(exception: unknown): exception is {
  getStatus(): number;
  getResponse(): string | object;
  message: string;
} {
  const candidate = exception as { getStatus?: unknown; getResponse?: unknown } | null;
  return typeof candidate?.getStatus === 'function' && typeof candidate?.getResponse === 'function';
}

/**
 * Reads a Prisma error code from an unknown throwable.
 *
 * @param exception Candidate value.
 * @returns The Prisma error code (e.g. `P2002`), or `null`.
 */
function readPrismaCode(exception: unknown): string | null {
  const candidate = exception as { code?: unknown; name?: unknown } | null;
  if (typeof candidate?.code === 'string' && /^P\d{4}$/.test(candidate.code)) {
    return candidate.code;
  }
  return null;
}

/**
 * Catches requests that matched no route.
 *
 * Nest handles this itself, but registering a handler keeps the response shape
 * identical to every other error, which matters for clients parsing the body.
 */
@Catch()
export class NotFoundFilter implements ExceptionFilter {
  private readonly logger = new Logger(NotFoundFilter.name);

  /** Reports the unmatched route as a `NotFoundException`. */
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const notFound =
      exception instanceof Object && 'status' in exception
        ? (exception as { status: number }).status === Number(HttpStatus.NOT_FOUND)
          ? new NotFoundException('Endpoint')
          : exception
        : new NotFoundException('Endpoint');

    this.logger.debug(`Unhandled ${request.method} ${redactRequestUrl(request.url)}`);

    response.status(notFound instanceof NotFoundException ? notFound.status : HttpStatus.NOT_FOUND).json({
      error: {
        code: 'NOT_FOUND',
        message: `No endpoint matches ${request.method} ${redactRequestUrl(request.url)}.`,
        retryable: false,
      },
      requestId: request.id ?? 'unknown',
      timestamp: new Date().toISOString(),
      source: 'application',
    });
  }
}
