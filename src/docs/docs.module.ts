import { Global, Module } from '@nestjs/common';
import { ScalarDocsService } from './scalar-docs.service';
import { AppConfig } from '../config/app-config.service';

/**
 * API documentation.
 *
 * {@link ScalarDocsService} is provided rather than instantiated in `main.ts` so
 * the same OpenAPI generation path is used by the runtime server and by
 * `scripts/generate-openapi.ts`, which writes a static `openapi.json` for CI
 * contract checks.
 */
@Global()
@Module({
  providers: [
    {
      provide: ScalarDocsService,
      useFactory: (config: AppConfig) => new ScalarDocsService(config),
      inject: [AppConfig],
    },
  ],
  exports: [ScalarDocsService],
})
export class DocsModule {}
