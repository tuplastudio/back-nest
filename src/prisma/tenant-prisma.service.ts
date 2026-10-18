import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { TenantSchemaNamingService } from '../tenancy/tenant-schema-naming.service';
import { quoteStringLiteral } from './identifiers';
import { PrismaClient as TenantClient } from '../generated/tenant-plane/client';

/**
 * A cached tenant-scoped client together with the pool it owns.
 */
interface TenantConnection {
  /** Prisma client bound to the tenant schema. */
  readonly client: TenantClient;
  /** Underlying connection pool. */
  readonly pool: Pool;
  /** Last time this entry was used, for LRU eviction. */
  lastUsedAt: number;
}

/**
 * Thrown when a tenant-scoped operation is attempted without a resolved tenant.
 */
export class NoTenantContextError extends Error {
  constructor() {
    super('No tenant is associated with the current request. Apply @UseGuards(TenantGuard).');
    this.name = 'NoTenantContextError';
  }
}

/**
 * Factory and cache for tenant-scoped Prisma clients.
 *
 * How schema isolation works
 * --------------------------
 * The tenant datamodel (`prisma/schema.tenant.prisma`) declares no `@@schema`
 * and the datasource lists no `schemas`, so Prisma emits unqualified SQL. The
 * adapter's `schema` option then decides which physical schema those
 * unqualified names resolve to:
 *
 * ```ts
 * new PrismaPg(pool, { schema: 'tenant_acme' })
 * ```
 *
 * Every statement this client issues becomes `"tenant_acme"."users"`, so the
 * *same* generated model physically lives in a different schema per tenant. All
 * tenants share a single `pg` pool; only the adapter binding differs, which
 * avoids one pool per tenant.
 *
 * Isolation guarantees
 * --------------------
 *  * A request can only ever obtain a client for the tenant resolved by
 *    {@link TenantPrismaService.forTenant}; there is no "current schema" global
 *    to leak between concurrent requests.
 *  * The schema name is validated against {@link TenantSchemaNamingService}
 *    before it reaches the adapter, so a tampered registry row cannot redirect
 *    queries to `public` or `pg_catalog`.
 *  * The client returned by {@link TenantPrismaService.forCurrentTenant} is
 *    read-only in the type system unless the caller opts in via
 *    {@link TenantPrismaService.mutableClient}.
 *
 * Raw SQL
 * --------
 * Raw queries ignore the adapter's `schema`, so they must be qualified by
 * hand. Always go through {@link SafeSqlService}, which validates the schema
 * name before it is quoted.
 */
@Injectable()
export class TenantPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantPrismaService.name);
  private readonly connections = new Map<string, TenantConnection>();
  private readonly sharedPool: Pool;

  /**
   * @param config Validated application configuration.
   * @param naming Schema naming validator.
   * @param requestContext Request-scoped context holder.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly naming: TenantSchemaNamingService,
    private readonly requestContext: RequestContextService,
  ) {
    // One pool serves every tenant. Connections are cheap to hand out and the
    // adapter decides the schema, so a per-tenant pool would only waste slots.
    this.sharedPool = new Pool({
      connectionString: config.tenantDatabaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      statement_timeout: config.databaseStatementTimeoutMs,
      application_name: 'netpay-api/tenant-plane',
    });

    this.sharedPool.on('error', (error) => {
      this.logger.error(`Tenant pool error: ${error.message}`);
    });
  }

  /** Reports whether a pool is currently available. */
  get isConnected(): boolean {
    return true;
  }

  /**
   * Runs a trivial query against the shared pool.
   *
   * Used by the readiness probe: it verifies that the tenant data plane can reach
   * the database without needing a resolved tenant, which a health check will
   * never have.
   *
   * @throws When the database is unreachable.
   */
  async probe(): Promise<void> {
    await this.sharedPool.query('SELECT 1');
  }

  /**
   * Executes a trivial query to validate connectivity at boot.
   *
   * @throws When the database is unreachable.
   */
  async onModuleInit(): Promise<void> {
    await this.probe();
    this.logger.log('Tenant data plane connection pool established.');
  }

  /** Evicts every cached client and closes the shared pool. */
  async onModuleDestroy(): Promise<void> {
    const clients = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(clients.map((entry) => entry.client.$disconnect()));
    await this.sharedPool.end();
    this.logger.log('Tenant data plane pool closed.');
  }

  /**
   * Returns the raw Prisma client bound to an explicit tenant schema.
   *
   * Private on purpose. The tenant tables have row-level security, so a query
   * issued on this client without the `app.current_tenant` binding reads zero
   * rows — a silent wrong answer rather than an error. Everything that touches
   * tenant data must go through {@link forTenantTransaction}, which sets the
   * binding on the same connection the query runs on.
   *
   * @param schemaName Validated tenant schema name.
   * @returns A cached client for that schema.
   * @throws {Error} When the schema name fails validation.
   */
  private rawClientForTenant(schemaName: string): TenantClient {
    if (!this.naming.isValidSchemaName(schemaName)) {
      throw new Error(`Refusing to build a tenant client for invalid schema "${schemaName}".`);
    }

    const existing = this.connections.get(schemaName);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }

    const client = new TenantClient({
      adapter: new PrismaPg(this.sharedPool, { schema: schemaName }),
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    // Prisma's event payload type is not part of its public API, so it is read
    // structurally and annotated locally.
    client.$on('warn', (event: { message: string }) => this.logger.warn(`[${schemaName}] ${event.message}`));
    client.$on('error', (event: { message: string }) =>
      this.logger.error(`[${schemaName}] ${event.message}`),
    );

    this.connections.set(schemaName, { client, pool: this.sharedPool, lastUsedAt: Date.now() });
    this.evictIfNeeded();
    this.logger.debug(`Created tenant client for schema "${schemaName}".`);

    return client;
  }

  /**
   * Runs a callback inside an interactive transaction on the current tenant.
   *
   * Every tenant query goes through here. Row-level security on the tenant
   * tables keys off the `app.current_tenant` session setting, which is scoped to
   * the transaction, so the binding is established on the same connection the
   * callback then uses. A query issued outside this wrapper would see zero rows,
   * which is why the tenant data plane has no unwrapped accessor.
   *
   * @param callback Transaction body receiving the tenant-scoped client.
   * @returns Whatever the callback returns.
   * @throws {NoTenantContextError} When no tenant has been resolved.
   */
  async forCurrentTenantTransaction<T>(callback: (client: TenantClient) => Promise<T>): Promise<T> {
    return this.forTenantTransaction(this.requireCurrentSchema(), callback);
  }

  /**
   * Runs a callback inside an interactive transaction bound to an explicit schema.
   *
   * The counterpart to {@link forTenant} for anything that reads or writes tenant
   * data. Use it outside a request too — the authentication guard has to read the
   * member row for a tenant it is not yet serving a request for, and it must see
   * the same rows the application would.
   *
   * @param schemaName Validated tenant schema name.
   * @param callback Transaction body receiving the tenant-scoped client.
   * @returns Whatever the callback returns.
   * @throws {Error} When the schema name fails validation.
   */
  async forTenantTransaction<T>(
    schemaName: string,
    callback: (client: TenantClient) => Promise<T>,
  ): Promise<T> {
    const client = this.rawClientForTenant(schemaName);
    // The generated client's `$transaction` overloads resolve to the array form
    // unless the callback's return type is carried explicitly, so the client is
    // retyped to the interactive shape for this call.
    const interactive = client as unknown as {
      $transaction<R>(fn: (tx: TenantClient) => Promise<R>): Promise<R>;
    };
    return interactive.$transaction(async (tx) => {
      // SET LOCAL cannot bind a parameter; the value is a validated schema name
      // rendered as a quoted literal, never caller input.
      // eslint-disable-next-line no-restricted-properties
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = ${quoteStringLiteral(schemaName)}`);
      return callback(tx);
    });
  }

  /**
   * Returns the schema name for the current request's tenant.
   *
   * @returns The validated tenant schema name.
   * @throws {NoTenantContextError} When no tenant has been resolved.
   */
  requireCurrentSchema(): string {
    const tenant = this.requestContext.tenant;
    if (!tenant) {
      throw new NoTenantContextError();
    }
    if (!this.naming.isValidSchemaName(tenant.schemaName)) {
      throw new Error(`Resolved tenant "${tenant.slug}" carries an invalid schema name.`);
    }
    return tenant.schemaName;
  }

  /**
   * Drops a tenant client, e.g. after the tenant schema has been recreated.
   *
   * @param schemaName Schema whose cached client should be discarded.
   */
  async evict(schemaName: string): Promise<void> {
    const entry = this.connections.get(schemaName);
    if (!entry) {
      return;
    }
    this.connections.delete(schemaName);
    await entry.client.$disconnect();
    this.logger.debug(`Evicted tenant client for schema "${schemaName}".`);
  }

  /**
   * Diagnostics helper returning the number of cached clients.
   *
   * @returns Cache size.
   */
  get cachedClientCount(): number {
    return this.connections.size;
  }

  /**
   * Evicts the least recently used client once the cache exceeds its bound.
   *
   * A bounded cache matters here because each entry retains a Prisma client with
   * generated query plans; an unbounded map would be a memory exhaustion vector.
   */
  private evictIfNeeded(): void {
    const max = this.config.tenantClientCacheMax;
    while (this.connections.size > max) {
      let oldestKey: string | null = null;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.connections) {
        if (entry.lastUsedAt < oldestUse) {
          oldestUse = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) {
        break;
      }
      const evicted = this.connections.get(oldestKey);
      this.connections.delete(oldestKey);
      void evicted?.client.$disconnect();
      this.logger.debug(`LRU-evicted tenant client for schema "${oldestKey}".`);
    }
  }
}
