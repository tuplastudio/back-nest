import { randomBytes } from 'node:crypto';

/**
 * PostgreSQL identifier validation shared by the SQL helpers and the provisioner.
 *
 * Deliberately duplicated as a tiny pure function so the provisioner can validate
 * without pulling in Nest's injector.
 */

/** Pattern every identifier this application emits must match. */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Reserved prefix for tenant schemas.
 *
 * Every path that turns a schema name into an identifier — `DROP SCHEMA`,
 * `SET LOCAL search_path`, `GRANT ... ON SCHEMA`, and the row-level security
 * policies — must use this one constant. The policies compare against the
 * schema's own name, so a divergent copy would silently deny every row rather
 * than fail loudly.
 */
export const TENANT_SCHEMA_PREFIX = 'tenant_';

/**
 * The single tenant-schema predicate.
 *
 * Both the character pattern and the reserved namespace are required, because
 * `public`, `pg_catalog` and `information_schema` all satisfy the pattern on
 * their own.
 *
 * @param schemaName Candidate schema name.
 * @returns `true` when the name is inside the reserved tenant namespace.
 */
export function isValidTenantSchemaName(schemaName: string): boolean {
  return (
    typeof schemaName === 'string' &&
    schemaName.startsWith(TENANT_SCHEMA_PREFIX) &&
    IDENTIFIER_PATTERN.test(schemaName)
  );
}

/**
 * Throws unless the name is inside the reserved tenant namespace.
 *
 * @param schemaName Candidate schema name.
 * @throws {Error} When the name fails validation.
 */
export function assertTenantSchemaName(schemaName: string): void {
  if (!isValidTenantSchemaName(schemaName)) {
    throw new Error(
      `Rejected tenant schema "${String(schemaName)}": must match ${IDENTIFIER_PATTERN.source} and start with "${TENANT_SCHEMA_PREFIX}".`,
    );
  }
}

/**
 * Validates a PostgreSQL identifier.
 *
 * @param identifier Candidate identifier.
 * @returns `true` when the value is safe to interpolate into SQL.
 */
export function isValidIdentifier(identifier: string): boolean {
  return typeof identifier === 'string' && IDENTIFIER_PATTERN.test(identifier);
}

/**
 * Quotes an identifier after validating it.
 *
 * @param identifier Candidate identifier.
 * @returns The double-quoted identifier.
 * @throws {Error} When the identifier fails validation.
 */
export function quoteIdentifier(identifier: string): string {
  if (!isValidIdentifier(identifier)) {
    throw new Error(
      `Rejected SQL identifier "${String(identifier)}": must match ${IDENTIFIER_PATTERN.source}.`,
    );
  }
  return `"${identifier}"`;
}

/**
 * Renders a validated identifier as a single-quoted SQL string literal.
 *
 * Needed for `SET LOCAL app.current_tenant = '...'`, where the value is a
 * string, not an object name, so `quoteIdentifier`'s double quotes would be
 * parsed as an identifier reference and rejected.
 *
 * The pattern admits no quote characters, so escaping cannot be bypassed; the
 * check is kept explicit so a future change to the pattern cannot silently turn
 * this into an injection point.
 *
 * @param identifier Candidate identifier.
 * @returns The single-quoted literal.
 * @throws {Error} When the identifier fails validation.
 */
export function quoteStringLiteral(identifier: string): string {
  if (!isValidIdentifier(identifier)) {
    throw new Error(
      `Rejected SQL string literal "${String(identifier)}": must match ${IDENTIFIER_PATTERN.source}.`,
    );
  }
  return `'${identifier}'`;
}

/**
 * Generates a short random identifier segment.
 *
 * @param bytes Number of random bytes.
 * @returns Hex encoded segment.
 */
export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}
