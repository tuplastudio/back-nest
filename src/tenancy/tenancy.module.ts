import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { RequestContextMiddleware } from '../bootstrap/request-context.middleware';
import { ResponseHeadersMiddleware } from '../bootstrap/response-headers.middleware';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { RequestContextService } from './request-context.service';
import { TenantGuard } from './tenant.guard';
import { TenantProvisionerService } from './tenant-provisioner.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantSchemaNamingService } from './tenant-schema-naming.service';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

/**
 * Tenant resolution, lifecycle and administration.
 *
 * Global because tenant identity is ambient: the request context, the tenant
 * Prisma factory and the PII helpers all need the resolver, and threading it
 * through every feature module adds noise without adding safety.
 *
 * Provides {@link TenantGuard} so tenant-facing controllers can apply it with
 * `@UseGuards(TenantGuard)` without importing this module.
 */
@Global()
@Module({
  // ApiKeysModule supplies ApiKeyService, which TenantsService uses to revoke keys
  // when a tenant is suspended or deleted. The module does not import TenancyModule,
  // so there is no cycle: it only consumes the globally exported providers here.
  imports: [ApiKeysModule],
  controllers: [TenantsController],
  providers: [
    RequestContextService,
    TenantResolverService,
    TenantSchemaNamingService,
    TenantProvisionerService,
    TenantsService,
    TenantGuard,
  ],
  exports: [
    RequestContextService,
    TenantResolverService,
    TenantSchemaNamingService,
    TenantProvisionerService,
    TenantsService,
    TenantGuard,
  ],
})
export class TenancyModule implements NestModule {
  /**
   * Registers the request pipeline for every route.
   *
   * The middleware is registered **here**, in the module that owns
   * {@link RequestContextService}, because Nest resolves a middleware's
   * dependencies from the module that declares it. Registering it elsewhere
   * would inject a second, separate `AsyncLocalStorage` and the guards would
   * read a different store than the middleware populated.
   *
   * Order matters: response headers first (so even a rejected request carries a
   * correlation id), then the request context (which every guard depends on).
   *
   * @param consumer Nest middleware consumer.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ResponseHeadersMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });

    consumer.apply(RequestContextMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
