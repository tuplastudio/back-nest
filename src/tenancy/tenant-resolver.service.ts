import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppConfig } from '../config/app-config.service';
import { PiiCryptoService } from '../pii/pii-crypto.service';
import { TenantStatus } from '../generated/control-plane/enums';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { RequestContextService } from './request-context.service';
import { TenantSchemaNamingService } from './tenant-schema-naming.service';
import { TenantContext } from './tenant-context.interface';

/**
 * In-memory cache entry for a resolved tenant.
 */
/**
 * Shape a native PostgreSQL `uuid` column can accept.
 *
 * Used to reject an `X-Tenant-Id` that cannot possibly name a registry row
 * before it reaches the database, mirroring what `bySlug` already does for slugs.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CacheEntry {
  /**
   * The cached tenant projection, or `null` when the key is known not to match.
   *
   * A remembered miss is what stops an attacker-chosen key from turning into one
   * control-plane query per request.
   */
  readonly tenant: TenantContext | null;
  /** Epoch milliseconds after which the entry must be re-read. */
  readonly expiresAt: number;
}

/**
 * Default time-to-live for cached tenant rows, in milliseconds.
 *
 * Short enough that a suspension takes effect promptly, long enough that the
 * control plane is not hit on every request.
 */
const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * Resolves the tenant for a request and caches the result.
 *
 * Resolution order
 * ----------------
 * 1. `X-Tenant-Id` — a tenant UUID. Used by service-to-service calls.
 * 2. `X-Tenant-Slug` — the business slug, e.g. `acme`.
 * 3. The request subdomain, e.g. `acme.api.example.com`.
 *
 * An explicit header always wins over the host so internal tooling can address a
 * tenant directly, and both paths converge on the same registry lookup. When no
 * tenant can be resolved the caller receives a clear 400 rather than silently
 * operating against the control plane.
 *
 * Caching
 * -------
 * Entries are held in a bounded LRU map with a short TTL. Bounded because an
 * unbounded map is a memory exhaustion vector when tenant slugs are attacker
 * controlled; short-lived because tenant status changes (suspension,
 * deprecation) must take effect quickly.
 */
@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  /**
   * @param prisma Control-plane Prisma service.
   * @param naming Schema naming helper, used to validate stored schema names.
   * @param config Validated application configuration.
   * @param crypto PII crypto service, used to hash the client IP.
   */
  constructor(
    private readonly prisma: ControlPlanePrismaService,
    private readonly naming: TenantSchemaNamingService,
    private readonly config: AppConfig,
    private readonly crypto: PiiCryptoService,
    private readonly requestContext: RequestContextService,
  ) {
    this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Resolves a tenant by its primary key.
   *
   * @param tenantId Tenant UUID as supplied by `X-Tenant-Id`.
   * @returns The tenant projection, or `null` when unknown.
   */
  async byId(tenantId: string): Promise<TenantContext | null> {
    // Mirror of `bySlug`: a value that cannot possibly name a row must not reach
    // the database. `Tenant.id` is a native uuid column, so a malformed header
    // otherwise costs one rejected statement and one error-level log line per
    // request — and tenant resolution runs in middleware, ahead of every guard,
    // so no throttle has been evaluated yet.
    if (!UUID_PATTERN.test(tenantId)) {
      this.logger.debug(`Rejected tenant id during resolution: not a UUID.`);
      return null;
    }

    const key = `id:${tenantId}`;
    const cached = this.readCache(key);
    if (cached.hit) {
      return cached.tenant;
    }

    const row = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: this.tenantSelect(),
    });
    return this.storeAndReturn(key, row);
  }

  /**
   * Resolves a tenant by its business slug.
   *
   * @param slug Tenant slug as supplied by `X-Tenant-Slug` or the subdomain.
   * @returns The tenant projection, or `null` when unknown.
   */
  async bySlug(slug: string): Promise<TenantContext | null> {
    try {
      this.naming.assertValidSlug(slug);
    } catch {
      // A malformed slug can never match a registry row; do not hit the database.
      this.logger.debug(`Rejected tenant slug "${slug}" during resolution.`);
      return null;
    }

    const key = `slug:${slug}`;
    const cached = this.readCache(key);
    if (cached.hit) {
      return cached.tenant;
    }

    const row = await this.prisma.client.tenant.findUnique({
      where: { slug },
      select: this.tenantSelect(),
    });
    return this.storeAndReturn(key, row);
  }

  /**
   * Extracts a tenant slug from a `Host` header.
   *
   * For `acme.api.example.com` with `API_BASE_DOMAIN=api.example.com` the
   * result is `acme`. Bare hosts, port-only hosts and hosts without a
   * recognised base domain yield `null`.
   *
   * @param host Raw `Host` header, with or without port; `null` when absent.
   * @returns The slug, or `null`.
   */
  slugFromHost(host: string | null | undefined): string | null {
    if (!host) {
      return null;
    }

    const hostname = host.split(':')[0].toLowerCase();
    const baseDomain = this.config.apiBaseDomain.toLowerCase();

    if (hostname === baseDomain) {
      return null;
    }
    if (!hostname.endsWith(`.${baseDomain}`)) {
      return null;
    }

    const subdomain = hostname.slice(0, -(baseDomain.length + 1));
    // Only the leftmost label is meaningful; `a.b.acme.api.example.com` is not
    // a tenant host.
    if (subdomain.length === 0 || subdomain.includes('.')) {
      return null;
    }

    try {
      return this.naming.assertValidSlug(subdomain);
    } catch {
      return null;
    }
  }

  /**
   * Resolves the tenant for the current request from headers and host.
   *
   * Stores the result in the request context so later services can read it.
   *
   * @param headers Lower-cased request headers.
   * @returns The resolved tenant, or `null` when the request has no tenant.
   */
  async resolveForRequest(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<TenantContext | null> {
    const tenantIdHeader = this.firstHeader(headers['x-tenant-id']);
    const slugHeader = this.firstHeader(headers['x-tenant-slug']);
    const hostHeader = this.firstHeader(headers.host);

    let tenant: TenantContext | null = null;

    if (tenantIdHeader) {
      tenant = await this.byId(tenantIdHeader);
    } else if (slugHeader) {
      tenant = await this.bySlug(slugHeader);
    } else {
      const slug = this.slugFromHost(hostHeader);
      if (slug) {
        tenant = await this.bySlug(slug);
      }
    }

    if (tenant) {
      this.requestContext.patch({ tenant });
    }
    return tenant;
  }

  /**
   * Returns a tenant only if it is usable for data operations.
   *
   * @param tenant Tenant to check.
   * @returns `true` when the tenant is `ACTIVE`.
   */
  isUsable(tenant: TenantContext): boolean {
    return tenant.status === TenantStatus.ACTIVE;
  }

  /**
   * Invalidates cached entries for a tenant after a registry write.
   *
   * @param tenant Tenant whose cache entries must be refreshed.
   */
  invalidate(tenant: { id: string; slug: string }): void {
    this.cache.delete(`id:${tenant.id}`);
    this.cache.delete(`slug:${tenant.slug}`);
  }

  /** Empties the cache, e.g. after a bulk migration. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Prisma select statement that limits the tenant projection to what the
   * request pipeline needs.
   *
   * @returns The select clause.
   */
  private tenantSelect() {
    return {
      id: true,
      slug: true,
      name: true,
      schemaName: true,
      status: true,
      plan: true,
      timezone: true,
      locale: true,
    } as const;
  }

  /**
   * Reads a cache entry, evicting it when expired.
   *
   * @param key Cache key.
   * @returns The cached tenant, or `null`.
   */
  private readCache(key: string): { hit: boolean; tenant: TenantContext | null } {
    const entry = this.cache.get(key);
    if (!entry) {
      return { hit: false, tenant: null };
    }
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return { hit: false, tenant: null };
    }
    // Refresh LRU recency.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { hit: true, tenant: entry.tenant };
  }

  /**
   * Maps a registry row into a {@link TenantContext} and caches it.
   *
   * @param key Cache key.
   * @param row Database row, possibly `null`.
   * @returns The projection, or `null` when the row does not exist.
   */
  private storeAndReturn(
    key: string,
    row: {
      id: string;
      slug: string;
      name: string;
      schemaName: string;
      status: TenantStatus;
      plan: string;
      timezone: string;
      locale: string;
    } | null,
  ): TenantContext | null {
    if (!row) {
      // Cache the miss. Without this, an attacker-chosen id is a guaranteed miss
      // and every request pays a fresh control-plane lookup, defeating the cache
      // this class documents as its defence against attacker-controlled keys.
      // The entry is the same bounded LRU as successes and expires with them, so
      // a newly created tenant becomes visible after the TTL like any other
      // change.
      this.cache.set(key, { tenant: null, expiresAt: Date.now() + this.cacheTtlMs });
      this.evictIfNeeded();
      return null;
    }

    // A corrupted schema name must never reach a SQL statement.
    if (!this.naming.isValidSchemaName(row.schemaName)) {
      this.logger.error(
        `Tenant "${row.slug}" has an invalid stored schema name. Refusing to serve it. ` +
          'Repair the registry row before allowing traffic.',
      );
      return null;
    }

    const tenant: TenantContext = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      schemaName: row.schemaName,
      status: row.status,
      plan: row.plan,
      timezone: row.timezone,
      locale: row.locale,
      resolvedAt: Date.now(),
    };

    this.cache.set(key, { tenant, expiresAt: Date.now() + this.cacheTtlMs });
    this.evictIfNeeded();
    return tenant;
  }

  /** Enforces the cache bound by evicting the oldest entry. */
  private evictIfNeeded(): void {
    const max = this.config.tenantClientCacheMax;
    while (this.cache.size > max) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
      this.logger.debug(`Evicted tenant cache entry "${oldestKey}".`);
    }
  }

  /**
   * Normalises a header that may be a string or an array.
   *
   * @param value Raw header value.
   * @returns The first value, or `null`.
   */
  private firstHeader(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  }

  /**
   * Convenience helper for hashing a client IP into the audit trail.
   *
   * @param ip Raw client IP.
   * @returns Keyed hash, or `null`.
   */
  hashIp(ip: string | null | undefined): string | null {
    return this.crypto.hashIp(ip ?? null);
  }

  /**
   * Computes the SHA-256 of a user agent string.
   *
   * @param userAgent Raw `User-Agent` header.
   * @returns Hex digest, or `null`.
   */
  hashUserAgent(userAgent: string | null | undefined): string | null {
    if (!userAgent) {
      return null;
    }
    return createHash('sha256').update(userAgent, 'utf8').digest('hex');
  }
}
