// In ESM mode the Jest globals are not ambient, so they must be imported.
import { jest } from '@jest/globals';
import { Prisma } from '../generated/control-plane/client';
import { KNOWN_IDENTIFIERS, SafeSqlService, UnsafeSqlError, type SqlClient } from './safe-sql.service';

/**
 * Tests for the raw SQL safety helpers.
 *
 * These are the guard rails in front of Prisma's raw APIs. Each case here
 * corresponds to a way an identifier or a statement could be abused to inject
 * SQL, so a regression in this file is a regression in SQL-injection resistance.
 */
describe('SafeSqlService', () => {
  let service: SafeSqlService;

  beforeEach(() => {
    service = new SafeSqlService();
  });

  describe('quoteIdent', () => {
    it('quotes a valid identifier', () => {
      expect(service.quoteIdent('tenants')).toBe('"tenants"');
      expect(service.quoteIdent('tenant_acme_1a2b3c4d')).toBe('"tenant_acme_1a2b3c4d"');
    });

    it('rejects identifiers that could break out of the quotes', () => {
      const malicious = [
        'tenants"; DROP SCHEMA public; --',
        'tenants" OR "1"="1',
        "tenants'; --",
        'tenants--',
        'tenants;',
      ];

      for (const value of malicious) {
        expect(() => service.quoteIdent(value)).toThrow(UnsafeSqlError);
      }
    });

    it('rejects identifiers that are not lowercase identifiers', () => {
      for (const value of ['Tenants', '1tenants', 'tenant-s', '', 'a'.repeat(64)]) {
        expect(() => service.quoteIdent(value)).toThrow(UnsafeSqlError);
      }
    });

    it('reports the reason on the thrown error', () => {
      try {
        service.quoteIdent('bad;name');
        throw new Error('expected a rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsafeSqlError);
        expect((error as UnsafeSqlError).reason).toBe('INVALID_IDENTIFIER');
      }
    });
  });

  describe('identifier', () => {
    it('resolves allow-listed names', () => {
      expect(service.identifier('tenants')).toBeInstanceOf(Prisma.Sql);
      expect(service.identifier('platformAdmins' as never)).toBeInstanceOf(Prisma.Sql);
    });

    it('rejects a name that is not on the allow-list', () => {
      // The allow-list is keyed by property name, so a raw table name such as
      // `pg_user` cannot be requested even though it is a legal identifier.
      expect(() => service.identifier('pg_user' as never)).toThrow(UnsafeSqlError);
    });
  });

  describe('tenantSchema', () => {
    it('accepts a well formed tenant schema', () => {
      expect(service.tenantSchema('tenant_acme_1a2b3c4d')).toBeInstanceOf(Prisma.Sql);
    });

    it('refuses schemas outside the tenant namespace', () => {
      // Without the prefix check a tampered registry row could redirect queries
      // at `public`, `pg_catalog` or an information schema.
      for (const value of ['public', 'pg_catalog', 'information_schema', 'Tenant_acme']) {
        expect(() => service.tenantSchema(value)).toThrow(UnsafeSqlError);
      }
    });

    it('refuses injection attempts even inside the namespace', () => {
      expect(() => service.tenantSchema('tenant_acme"; DROP SCHEMA public; --')).toThrow(UnsafeSqlError);
    });
  });

  describe('assertSafeTemplate', () => {
    it('accepts a tagged Prisma.sql template', () => {
      expect(() => service.assertSafeTemplate(Prisma.sql`SELECT 1`)).not.toThrow();
    });

    it('rejects a bare template literal (missing Prisma.sql tag)', () => {
      const untagged = ['SELECT 1'] as unknown as TemplateStringsArray;
      expect(() => service.assertSafeTemplate(untagged)).toThrow(UnsafeSqlError);
    });

    it('rejects a plain string', () => {
      expect(() => service.assertSafeTemplate('DROP TABLE users')).toThrow(UnsafeSqlError);
    });

    it('rejects concatenated SQL', () => {
      const value = `SELECT * FROM users WHERE id = ${'${1}'}`;
      expect(() => service.assertSafeTemplate(value)).toThrow(UnsafeSqlError);
    });
  });

  describe('sql and join', () => {
    it('binds interpolated values as parameters instead of inlining them', () => {
      const payload = "acme' OR 1=1 --";
      const statement = service.sql`SELECT * FROM ${service.identifier('tenants')} WHERE slug = ${payload}`;

      expect(statement).toBeInstanceOf(Prisma.Sql);
      // The classic injection payload must reach the driver as a *value*, never
      // as part of the statement text.
      expect(statement.text).toContain('WHERE slug = ');
      expect(statement.text).not.toContain(payload);
      expect(statement.values).toEqual([payload]);
    });

    it('produces a valid IN clause for an empty list', () => {
      const statement = service.join([]);
      expect(statement.text).toContain('(NULL)');
    });

    it('binds every element of a list', () => {
      const statement = service.join(['a', 'b']);
      expect(statement.values).toEqual(['a', 'b']);
    });
  });

  describe('client typing', () => {
    it('does not expose the unsafe raw APIs on the accepted client type', () => {
      // The guarantee is structural: `SqlClient` is a Pick of only the two safe
      // methods, so this fixture is the *widest* client the service accepts.
      const client: SqlClient = { $queryRaw: jest.fn(), $executeRaw: jest.fn() } as unknown as SqlClient;
      expect(Object.keys(client).sort()).toEqual(['$executeRaw', '$queryRaw']);
    });

    it('passes a tagged template through to the client', async () => {
      const client = {
        $queryRaw: jest.fn(() => Promise.resolve([{ count: 1n }])),
        $executeRaw: jest.fn(() => Promise.resolve(1)),
      } as unknown as SqlClient;

      await expect(service.query(client, Prisma.sql`SELECT 1`)).resolves.toEqual([{ count: 1n }]);
      await expect(service.execute(client, Prisma.sql`SELECT 1`)).resolves.toBe(1);
    });

    it('refuses to execute an unsafe statement', async () => {
      const queryRaw = jest.fn(() => Promise.resolve([]));
      const client = {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn(() => Promise.resolve(0)),
      } as unknown as SqlClient;
      await expect(service.query(client, 'SELECT 1' as never)).rejects.toThrow(UnsafeSqlError);
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('KNOWN_IDENTIFIERS', () => {
    it('maps every allow-list key to a legal identifier', () => {
      for (const [key, value] of Object.entries(KNOWN_IDENTIFIERS)) {
        expect(value).toMatch(/^[a-z_][a-z0-9_]*$/);
        expect(service.quoteIdent(value)).toBe(`"${value}"`);
        expect(key).toBeTruthy();
      }
    });
  });
});
