import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  TenantAuthController,
  TenantProjectsController,
  TenantUsersController,
} from './tenant-api.controller';
import { ProjectsService } from './projects.service';
import { TenantUsersService } from './tenant-users.service';

/**
 * Tenant-facing (data plane) API.
 *
 * Everything under `/t/**` operates on data inside the resolved tenant. Every
 * controller in this module applies {@link TenantGuard}, which guarantees the
 * tenant exists, is `ACTIVE`, and is therefore safe to hand to
 * `TenantPrismaService.forCurrentTenant()`.
 *
 * These routes are the ones an API key can call: they are scoped by the tenant
 * the key belongs to and by the scopes the key holds.
 */
@Module({
  // AuthModule supplies PasswordService and TokenService for member authentication.
  imports: [AuthModule],
  controllers: [TenantAuthController, TenantUsersController, TenantProjectsController],
  providers: [TenantUsersService, ProjectsService],
  exports: [TenantUsersService, ProjectsService],
})
export class TenantApiModule {}
