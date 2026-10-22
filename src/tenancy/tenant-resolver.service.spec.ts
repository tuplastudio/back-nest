import { jest } from '@jest/globals';
import { TenantResolverService } from './tenant-resolver.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantSchemaNamingService } from './tenant-schema-naming.service';
import type { AppConfig } from '../config/app-config.service';
import type { PiiCryptoService } from '../pii/pii-crypto.service';
import type { RequestContextService } from './request-context.service';

const KNOWN_UUID = '11111111-1111-4111-8111-111111111111';

/** A registry row as the resolver's select projection returns it. */
const ROW = {
  id: KNOWN_UUID,
  slug: 'acme',
  name: 'ACME',
  schemaName: 'tenant_acme_00000001',
  status: 'ACTIVE',
  plan: 'enterprise',
  timezone: 'UTC',
  locale: 'en',
} as never;

/**
 * Builds a resolver over a stub control plane that counts lookups.
 *
 * @param rows Rows the registry "contains".
 * @returns The resolver plus the lookup counter.
 */
function resolverOver(
  rows: unknown[],
  configOverrides: Partial<AppConfig> = {},
): {
  resolver: TenantResolverService;
  lookups: { count: number };
} {
  const lookups = { count: 0 };
  const client = {
    tenant: {
      findUnique: jest.fn(() => {
        lookups.count += 1;
        return Promise.resolve(rows.find(() => true) ?? null);
      }),
    },
  };
  const prisma = { client } as unknown as ControlPlanePrismaService;
  const naming = {
    assertValidSlug: (slug: string): void => {
      if (!/^[a-z0-9-]{1,63}$/.test(slug)) {
        throw new Error('invalid slug');
      }
    },
    isValidSchemaName: (): boolean => true,
  } as unknown as TenantSchemaNamingService;
  const config = { tenantClientCacheMax: 100, ...configOverrides } as AppConfig;
  const crypto = { hashIp: (): string => 'hash' } as unknown as PiiCryptoService;
  const requestContext = {} as RequestContextService;
  return {
    resolver: new TenantResolverService(prisma, naming, config, crypto, requestContext),
    lookups,
  };
}

describe('TenantResolverService.byId (regression: pre-validate and remember misses)', () => {
  it('never queries the database for a value that cannot be a UUID', async () => {
    // `Tenant.id` is a native uuid column. Before this guard a malformed
    // `X-Tenant-Id` cost one rejected statement per request, on a path that runs
    // in middleware ahead of the only rate limiter.
    const { resolver, lookups } = resolverOver([]);
    await expect(resolver.byId('not-a-uuid')).resolves.toBeNull();
    await expect(resolver.byId('')).resolves.toBeNull();
    await expect(resolver.byId("'; DROP TABLE tenants; --")).resolves.toBeNull();
    await expect(resolver.byId(`${KNOWN_UUID} OR 1=1`)).resolves.toBeNull();
    expect(lookups.count).toBe(0);
  });

  it('queries once for a well-formed id, then serves the result from cache', async () => {
    const { resolver, lookups } = resolverOver([ROW]);
    await expect(resolver.byId(KNOWN_UUID)).resolves.toMatchObject({ id: KNOWN_UUID });
    await resolver.byId(KNOWN_UUID);
    await resolver.byId(KNOWN_UUID);
    expect(lookups.count).toBe(1);
  });

  it('remembers a miss so an unknown id does not query on every request', async () => {
    // The cache is the documented defence against attacker-chosen keys; without
    // negative caching every unknown id was a guaranteed miss.
    const { resolver, lookups } = resolverOver([]);
    await expect(resolver.byId('22222222-2222-4222-8222-222222222222')).resolves.toBeNull();
    await resolver.byId('22222222-2222-4222-8222-222222222222');
    await resolver.byId('22222222-2222-4222-8222-222222222222');
    expect(lookups.count).toBe(1);
  });

  it('accepts an uppercase UUID, which the column does', async () => {
    const { resolver, lookups } = resolverOver([ROW]);
    await resolver.byId(KNOWN_UUID.toUpperCase());
    expect(lookups.count).toBe(1);
  });
});

describe('TenantResolverService.bySlug', () => {
  it('still rejects a malformed slug before querying', async () => {
    const { resolver, lookups } = resolverOver([]);
    await expect(resolver.bySlug('NOT A SLUG')).resolves.toBeNull();
    expect(lookups.count).toBe(0);
  });

  it('remembers a miss for an unknown but well-formed slug', async () => {
    const { resolver, lookups } = resolverOver([]);
    await resolver.bySlug('ghost');
    await resolver.bySlug('ghost');
    expect(lookups.count).toBe(1);
  });
});

describe('TenantResolverService cache TTL (BN-REQ-SEC-012: suspension visible in <= 5 s)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('re-reads the registry once the default TTL (5 s) has passed', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { resolver, lookups } = resolverOver([ROW]);
    await resolver.byId(KNOWN_UUID);
    now.mockReturnValue(1_000_000 + 4_999);
    await resolver.byId(KNOWN_UUID);
    expect(lookups.count).toBe(1);
    now.mockReturnValue(1_000_000 + 5_001);
    await resolver.byId(KNOWN_UUID);
    expect(lookups.count).toBe(2);
  });

  it('honours AUTHZ_CACHE_TTL_MS', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const { resolver, lookups } = resolverOver([ROW], { authzCacheTtlMs: 1_000 });
    await resolver.byId(KNOWN_UUID);
    now.mockReturnValue(2_000_000 + 1_001);
    await resolver.byId(KNOWN_UUID);
    expect(lookups.count).toBe(2);
  });
});
