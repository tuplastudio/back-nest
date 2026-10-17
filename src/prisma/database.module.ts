import { Global, Module } from '@nestjs/common';
import { ControlPlanePrismaService } from './control-plane-prisma.service';
import { SafeSqlService } from './safe-sql.service';
import { TenantPrismaService } from './tenant-prisma.service';
import { TenantSchemaNamingService } from '../tenancy/tenant-schema-naming.service';

/**
 * Database access layer.
 *
 * Registers the two Prisma services as named providers so they can be injected
 * either by class or by an explicit token:
 *
 * ```ts
 * constructor(private readonly prisma: ControlPlanePrismaService) {}
 * ```
 *
 * {@link SafeSqlService} is global because raw SQL is a cross-cutting concern:
 * any module needing raw access should be able to inject it without importing
 * this module explicitly.
 */
@Global()
@Module({
  providers: [
    ControlPlanePrismaService,
    TenantPrismaService,
    SafeSqlService,
    TenantSchemaNamingService,
    {
      provide: 'CONTROL_PLANE_PRISMA',
      useExisting: ControlPlanePrismaService,
    },
    {
      provide: 'TENANT_PRISMA',
      useExisting: TenantPrismaService,
    },
  ],
  exports: [ControlPlanePrismaService, TenantPrismaService, SafeSqlService, TenantSchemaNamingService],
})
export class DatabaseModule {}
