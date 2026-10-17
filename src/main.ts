import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config.service';
import { applyHttpSettings } from './bootstrap/apply-http-settings';
import { PiiRedactionService } from './pii/pii-redaction.service';
import { ScalarDocsService } from './docs/scalar-docs.service';

/**
 * Maximum accepted JSON request body size.
 *
 * Small on purpose: every endpoint in this base accepts compact documents, so a
 * generous limit would only give an attacker a cheap way to exhaust memory.
 */
const MAX_BODY_SIZE = '256kb';

/**
 * Application entry point.
 *
 * Boot sequence:
 *  1. create the Nest application,
 *  2. apply security headers, CORS, validation and the exception filter,
 *  3. mount the Scalar API reference,
 *  4. listen, and install signal handlers so an orchestrator can drain traffic.
 *
 * @throws When configuration is invalid or the database is unreachable; the
 * process exits non-zero so a supervisor restarts it rather than serving 500s.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Opt out of Nest's own body parsers so the size-capped ones registered below
    // are the only parsers. Leaving `bodyParser: true` ran two parsers per
    // request and made body-parser's own 100kb default the effective bound rather
    // than MAX_BODY_SIZE.
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(AppConfig);
  const redaction = app.get(PiiRedactionService);
  const docs = app.get(ScalarDocsService);

  // Size-capped body parsers, registered before any route can read a body.
  app.use(json({ limit: MAX_BODY_SIZE }));
  app.use(urlencoded({ extended: false, limit: MAX_BODY_SIZE }));

  applyHttpSettings(app, config, redaction);

  if (config.docsEnabled) {
    docs.mount(app, docs.buildDocument(app));
  }

  app.setGlobalPrefix(config.apiPrefix, {
    // Health probes and documentation answer on stable, unversioned paths so a
    // load balancer or Kubernetes probe never needs to know the API version.
    // The `{*path}` variants are required: Nest matches exclude patterns against
    // the whole route, so listing only `health` would leave `/health/live` prefixed.
    // Braces are the path-to-regexp v8 syntax Nest 12 relies on.
    exclude: ['health', 'health/{*path}', config.docsPath, `${config.docsPath}/{*path}`],
  });

  // The router has to be initialised before the catch-all is appended,
  // otherwise this middleware would run first and swallow every request.
  await app.init();

  // Registered after the router, so unmatched paths fall through to it and get
  // the same JSON error body as every other failure instead of Express' default
  // HTML 404 page.
  app.use((request: Request, response: Response) => {
    response.status(404).json({
      error: 'NOT_FOUND',
      message: `No endpoint matches ${request.method} ${request.url}.`,
      requestId: request.id ?? 'unknown',
      timestamp: new Date().toISOString(),
      source: 'application',
    });
  });

  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  logger.log(`Listening on http://0.0.0.0:${config.port} (${config.nodeEnv})`);
  logger.log(`API base path: /${config.apiPrefix}`);
  if (config.docsEnabled) {
    logger.log(`API reference: http://localhost:${config.port}/${config.docsPath}`);
  }
}

/* istanbul ignore next -- process lifecycle wiring */
bootstrap().catch((error: unknown) => {
  // Configuration and connectivity failures must abort the boot: a process that
  // starts but cannot serve is harder to diagnose than one that refuses to run.

  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
