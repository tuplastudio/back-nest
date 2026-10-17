import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { envSchema } from './env.validation';

/**
 * Immutable, fully validated runtime configuration.
 *
 * Everything the application reads from `process.env` passes through the Zod
 * schema in `./env.validation.ts` first, so this class can be trusted to hold
 * real values with the right types. Nothing else in the codebase should touch
 * `process.env` directly.
 */
@Injectable()
export class AppConfig {
  private readonly logger = new Logger(AppConfig.name);

  constructor(private readonly config: ConfigService) {}

  // ---------------------------------------------------------------------------
  // Application
  // ---------------------------------------------------------------------------

  /** Current execution mode. */
  get nodeEnv(): string {
    return this.config.getOrThrow<string>('app.nodeEnv');
  }

  /** `true` outside production. Used to relax a few hardening defaults. */
  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  /** `true` in the test environment, where seeded fixtures are allowed. */
  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  /** TCP port the HTTP server binds to. */
  get port(): number {
    return this.config.getOrThrow<number>('app.port');
  }

  /** Global route prefix, e.g. `api/v1`. */
  get apiPrefix(): string {
    return this.config.getOrThrow<string>('app.apiPrefix');
  }

  /** Base domain used to derive tenant subdomains (`acme.api.example.com`). */
  get apiBaseDomain(): string {
    return this.config.getOrThrow<string>('app.apiBaseDomain');
  }

  /** Number of reverse proxies to trust for `request.ip`. */
  get trustProxyHops(): number {
    return this.config.getOrThrow<number>('app.trustProxyHops');
  }

  /** Explicitly allowed CORS origins. */
  get corsOrigins(): string[] {
    return this.config.getOrThrow<string[]>('app.corsOrigins');
  }

  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------

  /** PostgreSQL connection string for the control plane. */
  get databaseUrl(): string {
    return this.config.getOrThrow<string>('database.url');
  }

  /**
   * PostgreSQL connection string for the tenant data plane.
   *
   * Falls back to the control-plane string when unset. Prefer setting it: the
   * data plane should not run as the provisioning role, or as a superuser.
   */
  get tenantDatabaseUrl(): string {
    return this.config.getOrThrow<string>('database.tenantDatabaseUrl');
  }

  /** Maximum number of cached tenant Prisma clients. */
  get tenantClientCacheMax(): number {
    return this.config.getOrThrow<number>('database.tenantClientCacheMax');
  }

  /** Maximum connections per tenant pool. */
  get databasePoolMax(): number {
    return this.config.getOrThrow<number>('database.poolMax');
  }

  /** Idle connection timeout for tenant pools, in milliseconds. */
  get databasePoolIdleTimeoutMs(): number {
    return this.config.getOrThrow<number>('database.poolIdleTimeoutMs');
  }

  /** Connection acquisition timeout for tenant pools, in milliseconds. */
  get databaseConnectionTimeoutMs(): number {
    return this.config.getOrThrow<number>('database.connectionTimeoutMs');
  }

  /**
   * `statement_timeout` applied to every pooled connection, in milliseconds.
   * A runaway tenant query can never pin a connection indefinitely.
   */
  get databaseStatementTimeoutMs(): number {
    return this.config.getOrThrow<number>('database.statementTimeoutMs');
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /** Secret used to sign access tokens. */
  get jwtAccessSecret(): string {
    return this.config.getOrThrow<string>('auth.jwtAccessSecret');
  }

  /** Secret used to sign refresh tokens. Deliberately different from above. */
  get jwtRefreshSecret(): string {
    return this.config.getOrThrow<string>('auth.jwtRefreshSecret');
  }

  /**
   * Base64 encoded 32-byte key used to encrypt payment credentials.
   *
   * Deliberately separate from {@link piiEncryptionKey}: a provider secret key
   * can move money and personal data cannot, so the two must not share a blast
   * radius or a rotation schedule.
   *
   * @returns The payments encryption key.
   */
  get paymentsEncryptionKey(): string {
    return this.config.getOrThrow<string>('payments.encryptionKey');
  }

  /** Root key for PII blind indexes (HMAC-SHA256). */
  get piiHmacKey(): string {
    return this.config.getOrThrow<string>('auth.piiHmacKey');
  }

  /** Base64 encoded 32-byte key for AES-256-GCM field encryption. */
  get piiEncryptionKey(): string {
    return this.config.getOrThrow<string>('auth.piiEncryptionKey');
  }

  /** Access token lifetime, e.g. `15m`. */
  get jwtAccessTtl(): string {
    return this.config.getOrThrow<string>('auth.jwtAccessTtl');
  }

  /** Refresh token lifetime, e.g. `30d`. */
  get jwtRefreshTtl(): string {
    return this.config.getOrThrow<string>('auth.jwtRefreshTtl');
  }

  /** Refresh token lifetime in milliseconds, for cookie `Max-Age`. */
  get jwtRefreshTtlMs(): number {
    return this.durationToMs(this.jwtRefreshTtl);
  }

  /** `iss` claim for issued tokens. */
  get jwtIssuer(): string {
    return this.config.getOrThrow<string>('auth.jwtIssuer');
  }

  /** `aud` claim for issued tokens. */
  get jwtAudience(): string {
    return this.config.getOrThrow<string>('auth.jwtAudience');
  }

  /** Failed sign-ins tolerated before an account is locked out. */
  get authMaxFailedAttempts(): number {
    return this.config.getOrThrow<number>('auth.maxFailedAttempts');
  }

  /** How long an account stays locked after exhausting the attempt budget. */
  get authLockoutDurationMs(): number {
    return this.durationToMs(this.config.getOrThrow<string>('auth.lockoutDuration'));
  }

  /** Request budget for the sign-in endpoints. */
  get authThrottleLimit(): number {
    return this.config.getOrThrow<number>('auth.throttleLimit');
  }

  /** Window for the sign-in throttle, in milliseconds. */
  get authThrottleTtlMs(): number {
    return this.durationToMs(this.config.getOrThrow<string>('auth.throttleTtl'));
  }

  /** Global per-IP request budget. */
  get throttleLimit(): number {
    return this.config.getOrThrow<number>('throttle.limit');
  }

  /** Window for the global throttle, in milliseconds. */
  get throttleTtlMs(): number {
    return this.durationToMs(this.config.getOrThrow<string>('throttle.ttl'));
  }

  // ---------------------------------------------------------------------------
  // Argon2id
  // ---------------------------------------------------------------------------

  /** Argon2id memory cost in KiB. */
  get argon2MemoryCost(): number {
    return this.config.getOrThrow<number>('argon2.memoryCost');
  }

  /** Argon2id iterations. */
  get argon2TimeCost(): number {
    return this.config.getOrThrow<number>('argon2.timeCost');
  }

  /** Argon2id lane count. */
  get argon2Parallelism(): number {
    return this.config.getOrThrow<number>('argon2.parallelism');
  }

  // ---------------------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------------------

  /** Human readable prefix of every issued API key. */
  get apiKeyPrefix(): string {
    return this.config.getOrThrow<string>('apiKeys.prefix');
  }

  /** Argon2id memory cost used when hashing API key secrets. */
  get apiKeyArgon2MemoryCost(): number {
    return this.config.getOrThrow<number>('apiKeys.memoryCost');
  }

  /** Argon2id iterations used when hashing API key secrets. */
  get apiKeyArgon2TimeCost(): number {
    return this.config.getOrThrow<number>('apiKeys.timeCost');
  }

  /** Default validity window applied to newly issued API keys. */
  get apiKeyDefaultTtlMs(): number {
    return this.config.getOrThrow<number>('apiKeys.defaultTtlDays') * 24 * 60 * 60 * 1000;
  }

  // ---------------------------------------------------------------------------
  // PII / logging
  // ---------------------------------------------------------------------------

  /** When true, PII is replaced by masked values in every log line. */
  get piiLogRedaction(): boolean {
    return this.config.getOrThrow<boolean>('pii.logRedaction');
  }

  /** Nest logger level. */
  get logLevel(): string {
    return this.config.getOrThrow<string>('pii.logLevel');
  }

  // ---------------------------------------------------------------------------
  // Docs
  // ---------------------------------------------------------------------------

  /** When true, the Scalar API reference is served. */
  get docsEnabled(): boolean {
    return this.config.getOrThrow<boolean>('docs.enabled');
  }

  /** Route the Scalar UI is mounted on. */
  get docsPath(): string {
    return this.config.getOrThrow<string>('docs.path');
  }

  /** HTTP Basic user guarding the docs outside development. */
  get docsBasicAuthUser(): string {
    return this.config.getOrThrow<string>('docs.basicAuthUser');
  }

  /** HTTP Basic password guarding the docs outside development. */
  get docsBasicAuthPassword(): string {
    return this.config.getOrThrow<string>('docs.basicAuthPassword');
  }

  /**
   * Converts a duration string (`900ms`, `15m`, `30d`) to milliseconds.
   *
   * @param value Duration string to convert.
   * @returns The equivalent number of milliseconds.
   * @throws {Error} When the format is not recognised.
   */
  private durationToMs(value: string): number {
    const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
    if (!match) {
      this.logger.error(`Invalid duration string: ${value}`);
      throw new Error(`Invalid duration string: ${value}`);
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return amount * multipliers[unit];
  }
}

/**
 * Typed accessor for a nested configuration namespace.
 *
 * @param namespace Dotted configuration path, e.g. `auth`.
 * @returns A typed getter bound to that namespace.
 */
export function configNamespace<T>(config: ConfigService, namespace: string) {
  return {
    get: <K extends keyof T>(key: K): T[K] => config.getOrThrow<T[K]>(`${namespace}.${String(key)}`),
  };
}

/** Inferred shape of the validated configuration object. */
export type AppConfigShape = z.infer<typeof envSchema>;
