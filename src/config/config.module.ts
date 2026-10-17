import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfig } from './app-config.service';
import { validateEnv } from './env.validation';

/**
 * Global configuration module.
 *
 * `validateEnv` runs before the DI container is built, so a misconfigured
 * deployment fails immediately with an actionable message instead of throwing
 * later at the first database call.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
      expandVariables: true,
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig, ConfigModule],
})
export class AppConfigModule {}
