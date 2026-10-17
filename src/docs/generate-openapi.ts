import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { AppConfig } from '../config/app-config.service';
import { ScalarDocsService } from './scalar-docs.service';
import { applyHttpSettings } from '../bootstrap/apply-http-settings';
import { PiiRedactionService } from '../pii/pii-redaction.service';

/**
 * Writes the generated OpenAPI 3.1 document to `docs/openapi.json`.
 *
 * Why a script rather than a runtime endpoint
 * -------------------------------------------
 * The document is the API's contract, so it belongs in version control and in CI
 * where it can be diffed and linted. It is generated from the same code path that
 * serves it at runtime, so it cannot drift from the DTOs.
 *
 * ```bash
 * npm run docs:openapi
 * ```
 *
 * The script lives under `src/` and is compiled with the application because Nest's
 * dependency injection relies on TypeScript's `design:paramtypes` metadata, which
 * only `tsc` emits — a transpile-only runner such as `tsx` would fail at boot.
 */
async function main(): Promise<void> {
  const logger = new Logger('OpenApiGenerator');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
  });

  const config = app.get(AppConfig);
  const docs = app.get(ScalarDocsService);

  // The same prefix the server uses, so the generated paths match the served ones.
  applyHttpSettings(app, config, app.get(PiiRedactionService));
  app.setGlobalPrefix(config.apiPrefix, {
    exclude: ['health', 'health/{*path}', config.docsPath, `${config.docsPath}/{*path}`],
  });
  await app.init();

  const document = docs.buildDocument(app);
  const targetDir = join(process.cwd(), 'docs');
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  logger.log(`OpenAPI document written to ${target}`);
}

/* istanbul ignore next -- script entry point */
main().catch((error: unknown) => {
  process.stderr.write(`Failed to generate the OpenAPI document: ${(error as Error).message}\n`);
  process.exit(1);
});
