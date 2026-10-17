import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';

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
  controllers: [HealthController],
  providers: [
    {
      provide: HealthService,
      useFactory: (controlPlane: ControlPlanePrismaService, tenantPlane: TenantPrismaService) =>
        new HealthService(controlPlane, tenantPlane, '1.0.0'),
      inject: [ControlPlanePrismaService, TenantPrismaService],
    },
  ],
  exports: [HealthService],
})
export class HealthModule {}
