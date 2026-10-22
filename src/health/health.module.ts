import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readBuildInfo } from '../config/build-info';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { PaymentsModule } from '../payments/payments.module';
import { WebhookDriftService } from '../payments/webhook-drift.service';

/**
 * Liveness and readiness probes.
 *
 * Both endpoints are `@Public()` and exempt from throttling so an orchestrator
 * can poll them without credentials and without being rate limited.
 *
 * The two probes are deliberately different in what they assert:
 * `/health/live` never touches the database (so a database outage cannot cause
 * a restart storm), while `/health/ready` does (so a broken instance stops
 * receiving traffic).
 */
@Module({
  // For the cached webhook drift summary of the authenticated report (BN-REQ-CFG-004).
  imports: [PaymentsModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HealthService,
      useFactory: (
        controlPlane: ControlPlanePrismaService,
        tenantPlane: TenantPrismaService,
        config: ConfigService,
        drift: WebhookDriftService,
      ) =>
        new HealthService(controlPlane, tenantPlane, {
          ...readBuildInfo(),
          outboundEnabled: config.getOrThrow<boolean>('outboundWebhooks.enabled'),
          webhookDrift: drift,
        }),
      inject: [ControlPlanePrismaService, TenantPrismaService, ConfigService, WebhookDriftService],
    },
  ],
  exports: [HealthService],
})
export class HealthModule {}
