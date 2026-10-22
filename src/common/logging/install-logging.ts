import { type INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import { createAccessLogMiddleware } from './access-log.middleware';
import { type ConfiguredLogLevel, JsonLogger, type LogContextFields } from './json-logger';

/** Configuration the logger needs, read from `AppConfig`. */
export interface LoggingSettings {
  /** `LOG_LEVEL`. */
  readonly logLevel: ConfiguredLogLevel;
  /** `GCP_PROJECT_ID`; turns trace ids into Cloud Logging trace links. */
  readonly gcpProjectId?: string;
}

/** Narrow view of `RequestContextService`, so this file does not import the tenancy module. */
export interface RequestContextReader {
  /** Returns the active request context, or an empty one outside a request. */
  get(): { readonly requestId: string; readonly tenant: { readonly id: string } | null };
}

/**
 * Replaces Nest's console logger with {@link JsonLogger} and registers the
 * access log as the first middleware.
 *
 * Must run before any other `app.use`: the access log measures latency from the
 * moment it sees the request, and opens the trace context every later line
 * inherits.
 *
 * @param app The Nest application, created with `bufferLogs: true` so lines
 * emitted during module init are flushed through this logger.
 * @param settings `LOG_LEVEL` and the GCP project.
 * @param requestContext Source of `requestId` and `tenantId` inside a request.
 * @param write Sink override, for tests.
 * @returns The installed logger.
 */
export function installLogging(
  app: Pick<INestApplication, 'useLogger' | 'use'>,
  settings: LoggingSettings,
  requestContext: RequestContextReader,
  write?: (line: string) => void,
): JsonLogger {
  const current = (): LogContextFields => {
    const context = requestContext.get();
    return {
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.tenant ? { tenantId: context.tenant.id } : {}),
    };
  };

  const logger = new JsonLogger({
    level: settings.logLevel,
    projectId: settings.gcpProjectId,
    context: current,
    write,
  });

  app.useLogger(logger);
  app.use(
    createAccessLogMiddleware(logger, {
      snapshot: (request: Request) => ({ requestId: request.id, ...current() }),
    }),
  );
  return logger;
}
