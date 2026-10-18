import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config.service';
import { PrismaClient } from '../generated/control-plane/client';

/**
 * Owns the Prisma client for the **control plane** — the `public` schema that
 * holds the tenant registry, platform administrators, API key metadata and the
 * audit trail.
 *
 * Responsibilities:
 *  * build one pooled connection using the `pg` driver adapter,
 *  * expose the client for injection elsewhere,
 *  * verify connectivity on boot so a misconfigured database fails fast,
 *  * close the pool on shutdown so in-flight requests drain cleanly.
 *
 * The control-plane client is deliberately **not** schema-scoped beyond `public`
 *; tenant data always goes through {@link TenantPrismaService}.
 */
@Injectable()
export class ControlPlanePrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlPlanePrismaService.name);
  private readonly pool: Pool;
  private readonly prismaClient: PrismaClient;
  private connected = false;

  /**
   * @param config Validated application configuration.
   */
  constructor(config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      // Applied per connection so a runaway query can never hold a slot.
      statement_timeout: config.databaseStatementTimeoutMs,
      application_name: 'netpay-api/control-plane',
    });

    this.prismaClient = new PrismaClient({
      adapter: new PrismaPg(this.pool, { schema: 'public' }),
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    // Forward driver-level warnings and errors into the application log. The
    // event payload type is not part of Prisma's public API, so it is read
    // structurally.
    type PrismaLogEvent = { message: string };
    this.prismaClient.$on('warn' as never, (event: PrismaLogEvent) => this.logger.warn(event.message));
    this.prismaClient.$on('error' as never, (event: PrismaLogEvent) => this.logger.error(event.message));

    // A pool-level error (server restart, network partition) must not crash the
    // process; the next query will establish a fresh connection.
    this.pool.on('error', (error) => {
      this.logger.error(`Control plane pool error: ${error.message}`);
    });
  }

  /**
   * The shared control-plane Prisma client.
   *
   * Injected as a provider with `useExisting` in `DatabaseModule`.
   */
  get client(): PrismaClient {
    return this.prismaClient;
  }

  /**
   * The underlying `pg` pool, needed by the provisioner to run DDL that Prisma's
   * query API does not model (`CREATE SCHEMA`, enum creation).
   */
  get rawPool(): Pool {
    return this.pool;
  }

  /** Whether a successful connectivity probe has completed. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Verifies database connectivity during application bootstrap.
   *
   * @throws When the control plane cannot be reached.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.prismaClient.$queryRaw`SELECT 1`;
      this.connected = true;
      this.logger.log('Control plane database connection established.');
    } catch (error) {
      this.logger.error(
        `Unable to reach the control plane database: ${(error as Error).message}. ` +
          'Check CONTROL_PLANE_DATABASE_URL and that the migrations have been applied.',
      );
      throw error;
    }
  }

  /** Drains the pool during application shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.prismaClient.$disconnect();
    await this.pool.end();
    this.connected = false;
    this.logger.log('Control plane database pool closed.');
  }
}
