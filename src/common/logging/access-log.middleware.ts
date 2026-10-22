import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type JsonLogger, type LogContextFields, logContextStorage, parseTraceContext } from './json-logger';

/** Placeholder written instead of a secret path segment. */
export const REDACTED_SEGMENT = '[REDACTED]';

/**
 * The inbound Netpay webhook carries its shared secret as the last path segment
 * (`/payments/webhook/<token>`). Whoever reads the logs must not be able to
 * forge a notification, so the segment never reaches a log line (BN-TASK-033).
 */
const WEBHOOK_TOKEN_SEGMENT = /(\/payments\/webhook\/)[^/?#]+/g;

/**
 * Makes a request path safe to log.
 *
 * Drops the query string (tokens and PII travel there too) and replaces the
 * webhook token segment.
 *
 * @param path `request.originalUrl` or any URL path.
 * @returns The path without query and with secret segments redacted.
 */
export function redactPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  return withoutQuery.replace(WEBHOOK_TOKEN_SEGMENT, `$1${REDACTED_SEGMENT}`);
}

/** Options for {@link createAccessLogMiddleware}. */
export interface AccessLogOptions {
  /**
   * Reads `requestId` and `tenantId` for the request. Called when the handler
   * ends the response, i.e. inside the request's async context, after the
   * request-context middleware and the guards have populated it.
   */
  snapshot?: (request: Request) => Pick<LogContextFields, 'requestId' | 'tenantId'>;
}

/**
 * Builds the access-log middleware: one structured line per request.
 *
 * Registered with `app.use` before anything else so the latency covers the
 * whole pipeline. It also opens the logging context carrying the Cloud Trace
 * id, so every application line emitted while serving the request is linked to
 * the same trace.
 *
 * The line is written on `finish`, or on `close` when the client went away
 * first; never both.
 *
 * @param logger Logger the lines go through, so `LOG_LEVEL` applies.
 * @param options See {@link AccessLogOptions}.
 * @returns An Express middleware.
 */
export function createAccessLogMiddleware(
  logger: JsonLogger,
  options: AccessLogOptions = {},
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const trace = parseTraceContext(request.get('x-cloud-trace-context'));
    const store: LogContextFields = { ...trace };

    let captured: Pick<LogContextFields, 'requestId' | 'tenantId'> = {};
    const capture = (): void => {
      try {
        captured = { ...captured, ...stripUndefined(options.snapshot?.(request) ?? {}) };
      } catch {
        // A failing snapshot must not break the response it is observing.
      }
    };

    // Capture on `end`, which runs inside the handler's async context, where
    // the request context still holds the tenant. By `finish` it may be gone.
    const originalEnd = response.end.bind(response) as (...args: unknown[]) => Response;
    response.end = ((...args: unknown[]): Response => {
      capture();
      return originalEnd(...args);
    }) as Response['end'];

    let written = false;
    const write = (): void => {
      if (written) {
        return;
      }
      written = true;
      if (!captured.requestId) {
        capture();
      }

      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const status = response.headersSent ? response.statusCode : 0;
      const level = status >= 500 || status === 0 ? 'error' : status >= 400 ? 'warn' : 'log';
      const path = redactPath(request.originalUrl || request.url);
      const route = routeOf(request);

      logContextStorage.run({ ...store, ...captured }, () => {
        logger.entry(level, {
          type: 'access',
          message: `${request.method} ${path} ${status} ${latencyMs.toFixed(1)}ms`,
          method: request.method,
          route,
          status,
          latencyMs: Math.round(latencyMs * 10) / 10,
          // Cloud Logging renders this object as a request entry. The client
          // IP and user agent are left out on purpose: they are PII.
          httpRequest: {
            requestMethod: request.method,
            requestUrl: path,
            status,
            latency: `${(latencyMs / 1000).toFixed(6)}s`,
            protocol: `HTTP/${request.httpVersion}`,
          },
        });
      });
    };

    response.once('finish', write);
    response.once('close', write);

    logContextStorage.run(store, next);
  };
}

/**
 * The matched route pattern, which keeps the label's cardinality bounded and
 * contains no ids or tokens.
 *
 * @param request The request, after routing.
 * @returns The Express route pattern, or `UNMATCHED`.
 */
function routeOf(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  if (route && typeof route.path === 'string') {
    return `${request.baseUrl}${route.path}`;
  }
  return 'UNMATCHED';
}

/** Removes keys whose value is `undefined`, so a later snapshot cannot erase an earlier one. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
