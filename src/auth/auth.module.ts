import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { ApiKeyScopesGuard } from './api-key-scopes.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AuthorizationService } from './authorization.service';
import { PermissionCatalog } from './permission-catalog';

/**
 * Authentication and password services.
 *
 * Exports {@link TokenService}, {@link PasswordService} and
 * {@link ApiKeyScopesGuard} so other modules can use them without depending on
 * this module's controller.
 *
 * The global authentication guard itself is registered in `AppModule` so it runs
 * for every route; only scopes are applied per controller.
 */
@Module({
  // JwtModule is registered without global options: TokenService passes the secret,
  // issuer, audience and expiry explicitly on every call, so tokens can never be
  // signed with a configuration value the module forgot about.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AdminAuthService,
    PasswordService,
    TokenService,
    ApiKeyScopesGuard,
    AuthorizationService,
    PermissionCatalog,
  ],
  exports: [
    AdminAuthService,
    PasswordService,
    TokenService,
    ApiKeyScopesGuard,
    AuthorizationService,
    PermissionCatalog,
  ],
})
export class AuthModule {}

/**
 * Applies the request context middleware to every route.
 *
 * Kept as a separate module so the middleware ordering is expressed once and
 * cannot drift between feature modules.
 */
@Module({})
export class AuthMiddlewareModule implements NestModule {
  /**
   * @param consumer Nest middleware consumer.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply().forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
