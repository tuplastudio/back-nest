import { InvalidTenantSlugError, TenantSchemaNamingService } from './tenant-schema-naming.service';

/**
 * Tests for the slug to schema mapping.
 *
 * This mapping is a security boundary: it decides which PostgreSQL schema a
 * request may address, so every case that could widen it is asserted here.
 */
describe('TenantSchemaNamingService', () => {
  let service: TenantSchemaNamingService;

  beforeEach(() => {
    service = new TenantSchemaNamingService();
  });

  describe('assertValidSlug', () => {
    it('accepts a normal slug', () => {
      expect(service.assertValidSlug('acme')).toBe('acme');
      expect(service.assertValidSlug('acme-corp-2')).toBe('acme-corp-2');
      expect(service.assertValidSlug('a1')).toBe('a1');
    });

    it('rejects uppercase, spaces and punctuation', () => {
      for (const slug of ['ACME', 'acme corp', 'acme_corp', 'acme!', '-acme', 'acme-', 'acmé']) {
        expect(() => service.assertValidSlug(slug)).toThrow(InvalidTenantSlugError);
      }
    });

    it('rejects empty and over-long values', () => {
      expect(() => service.assertValidSlug('')).toThrow(InvalidTenantSlugError);
      expect(() => service.assertValidSlug('a'.repeat(64))).toThrow(InvalidTenantSlugError);
    });

    it('accepts exactly 63 characters', () => {
      const slug = `a${'b'.repeat(61)}c`;
      expect(slug).toHaveLength(63);
      expect(service.assertValidSlug(slug)).toBe(slug);
    });
  });

  describe('toSchemaName', () => {
    it('always namespaces the schema under tenant_', () => {
      expect(service.toSchemaName('acme')).toMatch(/^tenant_/);
      expect(service.toSchemaName('public')).toMatch(/^tenant_/);
      // Even a slug named after a system schema cannot escape the namespace.
      expect(service.toSchemaName('pg-catalog')).toMatch(/^tenant_/);
    });

    it('produces a legal PostgreSQL identifier', () => {
      expect(service.toSchemaName('acme-corp')).toMatch(/^[a-z_][a-z0-9_]*$/);
    });

    it('is deterministic', () => {
      expect(service.toSchemaName('acme')).toBe(service.toSchemaName('acme'));
    });

    it('never exceeds the 63 character PostgreSQL limit', () => {
      const longSlug = `a${'b'.repeat(61)}c`;
      expect(longSlug).toHaveLength(63);
      expect(service.toSchemaName(longSlug).length).toBeLessThanOrEqual(63);
    });

    it('keeps long slugs distinct instead of colliding after truncation', () => {
      // Both slugs exceed the truncation budget, so only the checksum suffix can
      // tell them apart.
      const first = service.toSchemaName(`a${'b'.repeat(50)}c`);
      const second = service.toSchemaName(`a${'b'.repeat(50)}d`);
      expect(first).not.toBe(second);
    });

    it('produces different names for different slugs', () => {
      expect(service.toSchemaName('acme')).not.toBe(service.toSchemaName('globex'));
    });

    it('maps hyphens to underscores', () => {
      expect(service.toSchemaName('acme-corp')).toContain('acme_corp');
    });

    it('rejects an invalid slug rather than sanitising it', () => {
      // Silently rewriting a hostile slug would hide the attempt; failing loudly
      // is the correct behaviour at an API boundary.
      expect(() => service.toSchemaName('acme"; DROP SCHEMA public; --')).toThrow(InvalidTenantSlugError);
    });
  });

  describe('isValidSchemaName', () => {
    it('accepts a name produced by toSchemaName', () => {
      expect(service.isValidSchemaName(service.toSchemaName('acme'))).toBe(true);
    });

    it('rejects system and control plane schemas', () => {
      // This is the check the tenant Prisma service performs before building a
      // client, so a tampered registry row cannot redirect queries.
      for (const name of ['public', 'pg_catalog', 'information_schema', 'pg_temp_1', 'Tenant_acme', '']) {
        expect(service.isValidSchemaName(name)).toBe(false);
      }
    });
  });

  describe('fromSchemaName', () => {
    it('recovers a short slug', () => {
      expect(service.fromSchemaName(service.toSchemaName('acme-corp'))).toBe('acme-corp');
    });

    it('returns null for non-tenant schemas', () => {
      expect(service.fromSchemaName('public')).toBeNull();
      expect(service.fromSchemaName('tenant_')).toBeNull();
    });
  });
});
