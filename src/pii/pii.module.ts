import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { PiiCryptoService } from './pii-crypto.service';
import { PiiMaskService } from './pii-mask.service';
import { PiiRedactionService } from './pii-redaction.service';

/**
 * Provides the three PII primitives used across the application:
 *
 *  * {@link PiiCryptoService} — encryption and blind indexes for storage.
 *  * {@link PiiMaskService} — safe rendering of values in responses.
 *  * {@link PiiRedactionService} — scrubbing of values before logging.
 *
 * Global so any service can inject them without importing the module.
 */
@Global()
@Module({
  providers: [
    PiiMaskService,
    {
      provide: PiiCryptoService,
      useFactory: (config: AppConfig) => new PiiCryptoService(config.piiHmacKey, config.piiEncryptionKey),
      inject: [AppConfig],
    },
    {
      provide: PiiRedactionService,
      useFactory: (config: AppConfig) => new PiiRedactionService(config.piiLogRedaction),
      inject: [AppConfig],
    },
  ],
  exports: [PiiCryptoService, PiiMaskService, PiiRedactionService],
})
export class PiiModule {}
