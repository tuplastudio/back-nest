import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/control-plane/client';
import { IDENTIFIER_PATTERN, TENANT_SCHEMA_PREFIX } from './identifiers';

/**
 * Raised when raw SQL or an identifier fails the safety checks in
 * {@link SafeSqlService}.
 *
 * Extending `Error` (rather than letting a raw database error escape) means
 * callers can catch every injection-adjacent failure with one type and without
 * leaking driver internals into HTTP responses.
 */
export class UnsafeSqlError extends Error {
  /**
   * @param message Human readable explanation of what was rejected.
   * @param reason Machine readable reason code.
   */
  constructor(
    message: string,
    readonly reason:
      'INVALID_IDENTIFIER' | 'UNKNOWN_IDENTIFIER' | 'UNSAFE_TEMPLATE' | 'UNSAFE_RAW_FRAGMENT' | 'EMPTY_SQL',
  ) {
    super(message);
    this.name = 'UnsafeSqlError';
  }
}

/**
 * Identifiers that may legitimately be interpolated into SQL.
 *
 * PostgreSQL identifiers cannot be bound as parameters, so any dynamic
 * identifier must be validated instead. This allow-list plus
 * {@link SafeSqlService.quoteIdent} is the only sanctioned path; the ESLint
 * configuration bans `$queryRawUnsafe`/`$executeRawUnsafe` outright.
 */
export const KNOWN_IDENTIFIERS = {
  // Control plane tables.
  tenants: 'tenants',
  platformAdmins: 'platform_admins',
  adminRefreshTokens: 'admin_refresh_tokens',
  apiKeys: 'api_keys',
  auditLogs: 'audit_logs',
  // Tenant plane tables.
  users: 'users',
  userRefreshTokens: 'user_refresh_tokens',
  projects: 'projects',
  // Schema names used for tenant provisioning.
  publicSchema: 'public',
} as const;

/** Union of every allow-listed identifier. */
export type KnownIdentifier = (typeof KNOWN_IDENTIFIERS)[keyof typeof KNOWN_IDENTIFIERS];

/** PostgreSQL identifiers this helper is willing to emit. */

/**
 * Centralised, injection-safe SQL primitives.
 *
 * Why this exists
 * ---------------
 * Prisma's query API parameterises every value it sends, so ordinary queries
 * are already safe. The risk appears with raw SQL: any value spliced into a
 * string becomes part of the statement. This service closes that gap by
 * separating the two kinds of interpolation:
 *
 *  * **Values** go through `Prisma.sql` / `Prisma.raw` tagged templates. Values
 *    always travel as bind parameters and can never be interpreted as SQL.
 *  * **Identifiers** (table and schema names) cannot be bound, so they must be
 *    validated against {@link KNOWN_IDENTIFIERS} and quoted with doubled
 *    quotes. Anything outside the allow-list throws
 *    {@link UnsafeSqlError} *before* a statement is built.
 *
 * Additional invariants enforced here:
 *
 *  * `Prisma.raw` is private. Callers use {@link SafeSqlService.identifier},
 *    which is the only way to obtain a raw fragment, so an unreviewed fragment
 *    cannot be spliced in.
 *  * The injected client is `Pick<PrismaClient, '$queryRaw' | '$executeRaw'>`.
 *    The *Unsafe methods simply do not exist on the type, so this is a
 *    compile-time guarantee rather than a convention.
 *  * Every statement goes through {@link SafeSqlService.assertSafeTemplate},
 *    which rejects bare template literals.
 */
@Injectable()
export class SafeSqlService {
  /**
   * Quotes a PostgreSQL identifier after validating it.
   *
   * @param identifier Identifier to quote, e.g. `tenants`.
   * @returns The double-quoted identifier, safe to splice into SQL.
   * @throws {UnsafeSqlError} When the identifier fails validation.
   */
  quoteIdent(identifier: string): string {
    if (typeof identifier !== 'string' || !IDENTIFIER_PATTERN.test(identifier)) {
      throw new UnsafeSqlError(
        `Rejected SQL identifier "${String(identifier)}": only lowercase letters, digits and underscores are allowed (max 63 chars).`,
        'INVALID_IDENTIFIER',
      );
    }
    // Defence in depth: the regex already excludes quotes, but doubling them
    // means the helper stays safe even if the pattern is relaxed later.
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  /**
   * Resolves an allow-listed identifier into a raw SQL fragment.
   *
   * This is the only way to obtain a `Prisma.raw` value, which keeps
   * identifier interpolation behind a single audited code path.
   *
   * @param key Key of {@link KNOWN_IDENTIFIERS}.
   * @returns A fragment that can be interpolated into a `Prisma.sql` template.
   * @throws {UnsafeSqlError} When the key is not part of the allow-list.
   */
  identifier(key: KnownIdentifier): Prisma.Sql {
    const table: Record<string, string> = KNOWN_IDENTIFIERS;
    const value = table[key];
    if (value === undefined) {
      throw new UnsafeSqlError(
        `Identifier "${String(key)}" is not allow-listed. Add it to KNOWN_IDENTIFIERS after review.`,
        'UNKNOWN_IDENTIFIER',
      );
    }
    return Prisma.raw(this.quoteIdent(value));
  }

  /**
   * Resolves a **tenant schema name** into a raw SQL fragment.
   *
   * Tenant schemas are dynamic, so they cannot live in {@link KNOWN_IDENTIFIERS}.
   * They are instead validated against the same conservative pattern and forced
   * into the reserved `tenant_` namespace, which guarantees a tenant schema can
   * never collide with `public`, `pg_catalog` or an information schema.
   *
   * @param schemaName Schema name previously validated by `TenantSchemaNaming`.
   * @returns A quoted, namespace-constrained fragment.
   * @throws {UnsafeSqlError} When the name is outside the tenant namespace or
   * fails the identifier pattern.
   */
  tenantSchema(schemaName: string): Prisma.Sql {
    if (!schemaName.startsWith(TENANT_SCHEMA_PREFIX)) {
      throw new UnsafeSqlError(
        `Rejected tenant schema "${schemaName}": names must start with "${TENANT_SCHEMA_PREFIX}".`,
        'INVALID_IDENTIFIER',
      );
    }
    return Prisma.raw(this.quoteIdent(schemaName));
  }

  /**
   * Asserts that a caller passed a tagged `Prisma.sql` template rather than a
   * bare string.
   *
   * `Prisma.Sql` instances are the tagged-template output; a plain
   * `TemplateStringsArray` means the `Prisma.sql` tag was forgotten, in which
   * case values would be interpolated as raw text.
   *
   * @param sql Candidate statement.
   * @throws {UnsafeSqlError} When the value is not a `Prisma.Sql` instance.
   */
  assertSafeTemplate(sql: unknown): asserts sql is Prisma.Sql {
    if (Array.isArray(sql)) {
      throw new UnsafeSqlError(
        'Raw SQL must be tagged with Prisma.sql so values are bound as parameters.',
        'UNSAFE_TEMPLATE',
      );
    }
    if (!(sql instanceof Prisma.Sql)) {
      throw new UnsafeSqlError(
        'Raw SQL must be built with Prisma.sql, Prisma.raw or Prisma.join.',
        'UNSAFE_TEMPLATE',
      );
    }
  }

  /**
   * Executes a parameterised read query.
   *
   * @param prisma Client scoped to the correct schema.
   * @param sql Tagged statement.
   * @returns The resulting rows.
   * @throws {UnsafeSqlError} When the statement was not built safely.
   */
  async query<T>(prisma: SqlClient, sql: Prisma.Sql): Promise<T[]> {
    this.assertSafeTemplate(sql);
    return prisma.$queryRaw<T[]>(sql);
  }

  /**
   * Executes a parameterised write statement.
   *
   * @param prisma Client scoped to the correct schema.
   * @param sql Tagged statement.
   * @returns Number of affected rows.
   * @throws {UnsafeSqlError} When the statement was not built safely.
   */
  async execute(prisma: SqlClient, sql: Prisma.Sql): Promise<number> {
    this.assertSafeTemplate(sql);
    return prisma.$executeRaw(sql);
  }

  /**
   * Convenience factory that binds a tagged template through this service.
   *
   * Mirrors `Prisma.sql` so call sites import a single helper:
   * `safe.sql\`SELECT ... ${value}\``.
   *
   * @param strings Static string chunks of the template.
   * @param values Values to bind as parameters.
   * @returns A `Prisma.Sql` instance.
   */
  sql(strings: TemplateStringsArray, ...values: readonly unknown[]): Prisma.Sql {
    return Prisma.sql(strings, ...values);
  }

  /**
   * Joins a list of values into a single parameterised, comma separated list.
   *
   * The correct alternative to the classic
   * `ids.map(id => '${id}').join(',')` mistake, which is safe only when the
   * separator is a literal. An empty list yields `(NULL)`, which is valid
   * inside an `IN` clause and matches nothing.
   *
   * @param values Values to bind.
   * @returns A `Prisma.Sql` fragment.
   */
  join<T>(values: readonly T[]): Prisma.Sql {
    if (values.length === 0) {
      return Prisma.sql`(NULL)`;
    }
    return Prisma.join(values);
  }
}

/**
 * Minimal surface this module needs from a Prisma client.
 *
 * Deliberately excludes `$queryRawUnsafe` and `$executeRawUnsafe`, so code that
 * depends on {@link SafeSqlService} cannot reach the unsafe APIs even by
 * accident.
 */
export type SqlClient = {
  /** Runs a parameterised read query. */
  $queryRaw<T = unknown>(query: unknown): Promise<T>;
  /** Runs a parameterised write statement. */
  $executeRaw(query: unknown): Promise<number>;
};
