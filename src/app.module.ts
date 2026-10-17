import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiKeyScopesGuard } from './auth/api-key-scopes.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { AppConfig } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { DatabaseModule } from './prisma/database.module';
import { DocsModule } from './docs/docs.module';
import { HealthModule } from './health/health.module';
import { PiiModule } from './pii/pii.module';
import { PaymentsModule } from './payments/payments.module';
import { RbacAuditService } from './common/rbac-audit.service';
import { TenantApiModule } from './tenant-api/tenant-api.module';
import { TenancyModule } from './tenancy/tenancy.module';

/**
 * Application composition root.
 *
 * Global guard order (outermost first):
 *
 *  1. {@link ThrottlerGuard} — reject abusive traffic before it reaches
 *     authentication, so credential-stuffing attempts are cheap to absorb.
 *  2. {@link AuthGuard} — authenticate and attach the principal to the request
 *     context.
 *  3. {@link ApiKeyScopesGuard} — enforce the scopes a route declares.
 *
 * Guards are registered as `APP_GUARD` rather than with `@UseGuards` so a new
 * controller cannot accidentally be left unauthenticated. Deny-by-default is a
 * structural property here, not a convention.
 */
@Module({
  imports: [
    AppConfigModule,

    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => [
        { name: 'default', ttl: config.throttleTtlMs, limit: config.throttleLimit },
        { name: 'auth', ttl: config.authThrottleTtlMs, limit: config.authThrottleLimit },
      ],
    }),

    PiiModule,
    AuditModule,
    // Supplies DiscoveryService, which RbacAuditService uses to walk the route
    // table and verify every route declares an authorization policy.
    DiscoveryModule,
    DatabaseModule,
    TenancyModule,
    AuthModule,
    ApiKeysModule,
    TenantApiModule,
    PaymentsModule,
    HealthModule,
    DocsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ApiKeyScopesGuard },
    // Fine-grained authority: routes that declare @RequirePermissions are
    // judged against the caller's roles resolved through the RBAC catalogue.
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Authorization is deny-by-default too: this walks the route table on
    // bootstrap and refuses to start when a reachable route declares no policy.
    RbacAuditService,
  ],
})
export class AppModule {}

/**
 * Convenience factory for tests and scripts.
 *
 * Builds a fully wired application context without listening on a port, using
 * the same providers as the HTTP server. Useful for integration tests that need
 * the real DI graph.
 *
 * @returns A configured Nest application context.
 */
export async function createAppContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
}
