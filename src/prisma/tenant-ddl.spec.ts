import { createsEnumTypes, renderTenantDdl } from './tenant-ddl';

/**
 * Tests for the tenant DDL rewriter.
 *
 * If this rewriter ever stops stripping `CREATE SCHEMA` or stops qualifying
 * `CREATE TYPE`, tenant tables would silently land in the shared `public`
 * schema — a total loss of data isolation that no type checker would catch.
 */
describe('renderTenantDdl', () => {
  const prismaOutput = `
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER'
);

COMMIT;
`;

  it('removes the CREATE SCHEMA statement', () => {
    const rendered = renderTenantDdl(prismaOutput, 'tenant_acme_1a2b3c4d');

    // Prisma renders this for its own template schema. Left in place, every
    // tenant's tables would be created in `public`.
    expect(rendered).not.toMatch(/CREATE SCHEMA/i);
    expect(rendered).toContain('tenant_acme_1a2b3c4d');
  });

  it('qualifies enum types with the tenant schema', () => {
    const rendered = renderTenantDdl(prismaOutput, 'tenant_acme_1a2b3c4d');

    // PostgreSQL enums are schema-scoped, so an unqualified CREATE TYPE would
    // place the type in the first schema on the search_path.
    expect(rendered).toContain('CREATE TYPE "tenant_acme_1a2b3c4d"."MemberRole" AS ENUM');
    expect(rendered).not.toMatch(/CREATE TYPE\s+"MemberRole"/);
  });

  it('leaves table and column names unqualified for search_path resolution', () => {
    const rendered = renderTenantDdl(prismaOutput, 'tenant_acme_1a2b3c4d');

    expect(rendered).toContain('CREATE TABLE "users"');
    expect(rendered).toContain('"role" "MemberRole" NOT NULL');
  });

  it('drops the trailing COMMIT so the provisioner controls transaction scope', () => {
    const rendered = renderTenantDdl(prismaOutput, 'tenant_acme_1a2b3c4d');
    expect(rendered).not.toMatch(/^\s*COMMIT;/m);
  });

  it('handles several enum declarations', () => {
    const rendered = renderTenantDdl(
      `CREATE TYPE "A" AS ENUM ('x');\nCREATE TYPE "B" AS ENUM ('y');\n`,
      'tenant_acme_1a2b3c4d',
    );
    expect(rendered).toContain('CREATE TYPE "tenant_acme_1a2b3c4d"."A" AS ENUM');
    expect(rendered).toContain('CREATE TYPE "tenant_acme_1a2b3c4d"."B" AS ENUM');
  });

  it('refuses an invalid schema name', () => {
    expect(() => renderTenantDdl(prismaOutput, 'public')).toThrow();
    expect(() => renderTenantDdl(prismaOutput, 'acme"; DROP SCHEMA public; --')).toThrow();
    expect(() => renderTenantDdl(prismaOutput, 'tenant_acme"; DROP SCHEMA public; --')).toThrow();
  });

  it('detects enum creation', () => {
    expect(createsEnumTypes(prismaOutput)).toBe(true);
    expect(createsEnumTypes('CREATE TABLE x (id int);')).toBe(false);
  });
});
