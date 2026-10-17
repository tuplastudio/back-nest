import {
  assertTenantSchemaName as assertSharedTenantSchemaName,
  quoteIdentifier,
  quoteStringLiteral,
} from './identifiers';

/**
 * Prefix every tenant schema must carry.
 *
 * Enforced here as well as in `SafeSqlService.tenantSchema`, because the DDL
 * path bypasses the raw-SQL helpers entirely: it needs the same guarantee that a
 * schema name can never address `public`, `pg_catalog` or an information
 * schema.
 */

/**
 * Validates that a name is a legal tenant schema identifier.
 *
 * @param schemaName Candidate schema name.
 * @throws {Error} When the name is invalid or outside the tenant namespace.
 */
export function assertTenantSchemaName(schemaName: string): void {
  assertSharedTenantSchemaName(schemaName);
}

/**
 * Rewrites a tenant-plane migration so it applies to a specific schema.
 *
 * Prisma renders the tenant datamodel with unqualified names and emits its own
 * `CREATE SCHEMA IF NOT EXISTS "public"`. Reusing that script verbatim for a
 * tenant schema would put the tables in `public` — exactly the isolation failure
 * this base exists to prevent — so two rewrites are required:
 *
 *  1. **`CREATE SCHEMA`** is removed. The provisioner creates the schema itself,
 *     so it controls naming and permissions.
 *  2. **`CREATE TYPE`** is schema-qualified. PostgreSQL enums are schema-scoped
 *     objects, and a column declared as `"role" "MemberRole"` resolves the type
 *     through `search_path`. Qualifying the creation guarantees the enum lands in
 *     the tenant schema even if the statement runs before `search_path` is set.
 *
 * Tables, columns and constraints stay unqualified: they resolve through
 * `search_path`, which the provisioner sets transaction-locally.
 *
 * @param sql Migration script as rendered by `prisma migrate diff`.
 * @param schemaName Target tenant schema, already validated by the caller.
 * @returns The rewritten script.
 */
export function renderTenantDdl(sql: string, schemaName: string): string {
  assertTenantSchemaName(schemaName);
  const quoted = quoteIdentifier(schemaName);

  return (
    sql
      // The provisioner owns schema creation.
      .replace(/CREATE SCHEMA[^;]*;/gi, `-- schema ${quoted} is created by the tenant provisioner`)
      // Enums must be created inside the tenant schema.
      .replace(/CREATE TYPE\s+("(?:[^"]|"")+")\s+AS\s+ENUM/gi, (_match, typeName: string) => {
        return `CREATE TYPE ${quoted}.${typeName} AS ENUM`;
      })
      // Templates cannot know which tenant they are being rendered for, so they
      // carry a placeholder in each of the two syntactic contexts it appears in:
      //
      //   __TENANT_SCHEMA_LITERAL__  a text literal, compared by the row-level
      //                              security policies against the value the
      //                              application sets with SET LOCAL;
      //   __TENANT_SCHEMA__          an identifier, used by GRANT and
      //                              ALTER DEFAULT PRIVILEGES.
      //
      // They must not be the same token: `quoteIdentifier` emits double quotes,
      // which are correct in an identifier position and wrong inside a string
      // literal, where they would make every policy comparison false and deny
      // all rows. Both substitutions run after `assertTenantSchemaName` has
      // rejected anything outside `tenant_[a-z0-9_]{0,55}`, so neither can carry
      // injected SQL. The literal is substituted first; the two tokens do not
      // overlap because `__TENANT_SCHEMA__` requires `__` immediately after
      // `__TENANT_SCHEMA`, which `_LITERAL__` breaks.
      .replace(/__TENANT_SCHEMA_LITERAL__/g, quoteStringLiteral(schemaName))
      .replace(/__TENANT_SCHEMA__/g, quoted)
      // Drop Prisma's trailing transaction directives; the provisioner runs each
      // migration inside its own transaction and manages isolation itself.
      .replace(/^\s*COMMIT;?\s*$/gim, '')
  );
}

/**
 * Detects whether a rendered migration creates enum types.
 *
 * Useful for asserting, in a test, that a new tenant migration keeps the
 * enum-qualification behaviour intact.
 *
 * @param sql Migration script.
 * @returns `true` when the script contains `CREATE TYPE`.
 */
export function createsEnumTypes(sql: string): boolean {
  return /CREATE\s+TYPE/i.test(sql);
}
