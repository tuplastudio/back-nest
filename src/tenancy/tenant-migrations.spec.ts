import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyTenantMigrations,
  checksumOf,
  ledgerDdl,
  loadTenantMigrations,
  planTenantMigrations,
  type TenantMigration,
  TenantMigrationMismatchError,
} from './tenant-migrations';

const m = (version: number, sql = `-- v${version}`): TenantMigration => ({
  version,
  name: `${String(version).padStart(4, '0')}_m${version}`,
  sql,
  checksum: checksumOf(sql),
});

describe('tenant migrations (BN-TASK-042)', () => {
  describe('checksumOf', () => {
    it('is sha256 hex and ignores CRLF vs LF only', () => {
      expect(checksumOf('a\nb')).toMatch(/^[0-9a-f]{64}$/);
      expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
      expect(checksumOf('a\nb -- edited')).not.toBe(checksumOf('a\nb'));
    });
  });

  describe('loadTenantMigrations', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tm-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const add = (name: string, sql = 'SELECT 1;') => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'migration.sql'), sql);
    };

    it('orders by numeric version', () => {
      add('0010_b');
      add('0002_a');
      expect(loadTenantMigrations(dir).map((x) => x.version)).toEqual([2, 10]);
    });

    it('rejects duplicate versions and malformed names instead of skipping them', () => {
      add('0002_a');
      add('0002_b');
      expect(() => loadTenantMigrations(dir)).toThrow(/share version 2/);
      rmSync(join(dir, '0002_b'), { recursive: true });
      add('draft');
      expect(() => loadTenantMigrations(dir)).toThrow(/must be named/);
    });

    it('loads the repository migrations, including the ledger migration', () => {
      const all = loadTenantMigrations(join(process.cwd(), 'prisma', 'tenant-migrations'));
      expect(all.some((x) => x.name.endsWith('_tenant_schema_migrations'))).toBe(true);
    });
  });

  describe('planTenantMigrations', () => {
    const files = [m(1), m(2), m(3)];

    it('adopts an unledgered schema from schemaVersion', () => {
      const plan = planTenantMigrations([], files, 2);
      expect(plan.baseline.map((x) => x.version)).toEqual([1, 2]);
      expect(plan.pending.map((x) => x.version)).toEqual([3]);
      expect(plan.mismatches).toEqual([]);
    });

    it('plans only what the ledger lacks', () => {
      const ledger = files.slice(0, 2).map(({ version, checksum }) => ({ version, checksum }));
      expect(planTenantMigrations(ledger, files, 0).pending.map((x) => x.version)).toEqual([3]);
    });

    it('flags an edited, a deleted and an inserted-under-history migration', () => {
      const ledger = [
        { version: 1, checksum: 'f'.repeat(64) },
        { version: 3, checksum: files[2]?.checksum ?? '' },
        { version: 4, checksum: 'a'.repeat(64) },
      ];
      const plan = planTenantMigrations(ledger, files, 0);
      expect(plan.mismatches).toEqual([
        expect.stringMatching(/0001_m1 was modified after being applied/),
        expect.stringMatching(/version 4 is recorded as applied but has no migration file/),
        expect.stringMatching(/0002_m2 is older than applied version 4/),
      ]);
    });
  });

  describe('ledgerDdl', () => {
    it('refuses a schema outside the tenant namespace', () => {
      expect(() => ledgerDdl('public')).toThrow();
      expect(ledgerDdl('tenant_acme')).toContain('"tenant_acme"."tenant_schema_migrations"');
    });
  });

  describe('applyTenantMigrations', () => {
    function fakeDb(ledger: Array<{ version: number; checksum: string }>) {
      const statements: Array<{ sql: string; params?: readonly unknown[] }> = [];
      return {
        statements,
        db: {
          query: <T>(sql: string, params?: readonly unknown[]) => {
            statements.push({ sql, params });
            return Promise.resolve((sql.startsWith('SELECT "version"') ? ledger : []) as T[]);
          },
          exec: (sql: string) => {
            statements.push({ sql });
            return Promise.resolve();
          },
        },
      };
    }

    it('takes the advisory lock first, then records each applied migration with its checksum', async () => {
      const { db, statements } = fakeDb([]);
      const writes: number[] = [];
      const result = await applyTenantMigrations(db, 'tenant_acme', [m(1), m(2)], {
        read: () => Promise.resolve(1),
        write: (v) => {
          writes.push(v);
          return Promise.resolve();
        },
      });

      expect(statements[0]).toEqual({
        sql: 'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))',
        params: ['tenant_acme'],
      });
      expect(result).toEqual({ schemaName: 'tenant_acme', baselined: [1], applied: [2], version: 2 });
      const inserts = statements.filter((s) => s.sql.startsWith('INSERT INTO'));
      expect(inserts.map((s) => s.params)).toEqual([
        [1, '0001_m1', m(1).checksum, true],
        [2, '0002_m2', m(2).checksum, false],
      ]);
      expect(writes).toEqual([2]);
    });

    it('throws on mismatch without executing anything', async () => {
      const { db, statements } = fakeDb([{ version: 1, checksum: '0'.repeat(64) }]);
      await expect(
        applyTenantMigrations(db, 'tenant_acme', [m(1), m(2)], {
          read: () => Promise.resolve(1),
          write: () => Promise.resolve(),
        }),
      ).rejects.toBeInstanceOf(TenantMigrationMismatchError);
      expect(statements.some((s) => s.sql.includes('-- v2'))).toBe(false);
    });
  });
});
