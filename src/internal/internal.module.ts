import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { InternalController } from './internal.controller';
import { InternalInvokerGuard, GOOGLE_JWKS } from './internal-invoker.guard';
import { GoogleJwksSource } from './google-id-token';

/**
 * Internal routes: called by Cloud Scheduler with a Google OIDC ID token, never by
 * a tenant (BN-TASK-016).
 */
@Module({
  imports: [PaymentsModule],
  controllers: [InternalController],
  providers: [InternalInvokerGuard, { provide: GOOGLE_JWKS, useFactory: () => new GoogleJwksSource() }],
})
export class InternalModule {}
