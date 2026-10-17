import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { type AppConfig } from '../config/app-config.service';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { type PiiRedactionService } from '../pii/pii-redaction.service';

/**
 * The slice of the Express application this module touches.
 */
interface ExpressLike {
  /** Sets an Express application setting, e.g. `'trust proxy'`. */
  set(key: string, value: unknown): unknown;
}

/**
 * Origin allow-list evaluator handed to `app.enableCors`.
 *
 * Only explicitly configured origins are accepted; the request `Origin` header
 * is never reflected blindly, which would let any site issue authenticated
 * cross-origin requests.
 */
export type CorsOriginValidator = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => void;

/**
 * Applies the cross-cutting HTTP configuration to a Nest application.
 *
 * Extracted from `main.ts` so end-to-end tests can build an application with
 * byte-identical security settings without duplicating the configuration.
 *
 * @param app The Nest application instance.
 * @param config Validated application configuration.
 * @param redaction PII scrubber injected into the global exception filter.
 */
export function applyHttpSettings(
  app: INestApplication,
  config: AppConfig,
  redaction: PiiRedactionService,
): void {
  const logger = new Logger('HttpSettings');

  // Behind N reverse proxies, `request.ip` only reflects the real client when
  // Express is told how many hops to trust. Zero means "never trust X-Forwarded-For".
  // Nest types `getInstance()` as `any`. Express exposes app settings through
  // `set`, so the call is funnelled through a narrow local interface instead of
  // letting an `any` leak into the rest of the file.
  const express = app.getHttpAdapter().getInstance() as unknown as ExpressLike;
  express.set('trust proxy', config.trustProxyHops);

  app.use(
    helmet({
      // The API returns JSON only; the docs UI is the sole HTML surface and
      // therefore the sole reason for a relaxed policy.
      contentSecurityPolicy: config.docsEnabled
        ? {
            useDefaults: false,
            directives: {
              'default-src': ["'self'"],
              'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
              'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
              'img-src': ["'self'", 'data:', 'https:'],
              'connect-src': ["'self'", 'https:'],
              'font-src': ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
              'frame-ancestors': ["'none'"],
              'object-src': ["'none'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
      // HSTS is meaningless over plain HTTP and would break local development.
      hsts: config.isDevelopment ? false : { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      frameguard: { action: 'deny' },
      noSniff: true,
    }),
  );

  const originValidator: CorsOriginValidator = (origin, callback) => {
    // Non-browser clients (curl, server-to-server) send no Origin header.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    logger.warn(`Blocked CORS request from disallowed origin "${origin}".`);
    callback(null, false);
  };

  app.enableCors({
    origin: originValidator,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Content-Length',
      'Accept',
      'Authorization',
      'X-Tenant-Id',
      'X-Tenant-Slug',
      'X-Request-Id',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  // Deny-by-default input validation: unknown properties are rejected rather
  // than silently dropped, so a client typo surfaces as a 400 instead of being
  // ignored.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(redaction));
  app.enableShutdownHooks();
}
