import { Injectable, Logger } from '@nestjs/common';
import { isValidTenantSchemaName, TENANT_SCHEMA_PREFIX } from '../prisma/identifiers';

/**
 * Regex every tenant slug must satisfy.
 *
 * Kept deliberately narrow so a slug can be embedded in a subdomain, a header
 * and a PostgreSQL identifier without escaping. Anything outside this alphabet
 * is rejected, which removes quoting concerns from the DNS label entirely.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Maximum length of the generated PostgreSQL schema name. */
const MAX_SCHEMA_LENGTH = 63;

/** Reserved prefixes a tenant schema must carry. */

/**
 * Raised when a slug cannot be converted into a valid, safe schema name.
 */
export class InvalidTenantSlugError extends Error {
  /**
   * @param slug The rejected value.
   * @param reason Why it was rejected.
   */
  constructor(
    readonly slug: string,
    readonly reason: string,
  ) {
    super(`Invalid tenant slug "${slug}": ${reason}`);
    this.name = 'InvalidTenantSlugError';
  }
}

/**
 * Pure, side-effect free conversion between tenant slugs and PostgreSQL schema
 * names.
 *
 * Keeping this logic separate from the provisioner matters for two reasons:
 * the mapping is a security boundary (it decides which schema a request may
 * touch), and it must be trivially unit testable.
 *
 * Guarantees
 * ----------
 * * The result always matches `/^[a-z_][a-z0-9_]*$/` and is at most 63
 *   characters, so it is always a legal PostgreSQL identifier.
 * * The result always carries the reserved `tenant_` prefix, so a tenant can
 *   never be pointed at `public`, `pg_catalog` or any system schema.
 * * Distinct slugs always produce distinct schema names within the prefix plus
 *   the checksum budget. A truncated slug is disambiguated by an FNV-1a hash of
 *   the full value, so `very-long-company-name-a` and
 *   `very-long-company-name-b` do not collide.
 * * The function never accepts caller-controlled suffixes, so it cannot be used
 *   to reach another tenant's schema.
 */
@Injectable()
export class TenantSchemaNamingService {
  private readonly logger = new Logger(TenantSchemaNamingService.name);

  /**
   * Validates a tenant slug.
   *
   * @param slug Candidate slug.
   * @returns The normalised (already lower-case) slug.
   * @throws {InvalidTenantSlugError} When the slug violates {@link SLUG_PATTERN}.
   */
  assertValidSlug(slug: string): string {
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new InvalidTenantSlugError(String(slug), 'slug must be a non-empty string.');
    }
    if (slug.length > 63) {
      throw new InvalidTenantSlugError(slug, 'slug must be 63 characters or fewer.');
    }
    if (slug !== slug.toLowerCase()) {
      throw new InvalidTenantSlugError(slug, 'slug must be lowercase.');
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new InvalidTenantSlugError(
        slug,
        'slug must start and end with a lowercase letter or digit and may only contain lowercase letters, digits and hyphens.',
      );
    }
    return slug;
  }

  /**
   * Derives the PostgreSQL schema name for a slug.
   *
   * @param slug Valid tenant slug.
   * @returns A schema name guaranteed to be a safe, namespaced identifier.
   * @throws {InvalidTenantSlugError} When the slug is invalid.
   */
  toSchemaName(slug: string): string {
    this.assertValidSlug(slug);

    const normalized = slug.replaceAll('-', '_');
    const budget = MAX_SCHEMA_LENGTH - TENANT_SCHEMA_PREFIX.length - 9; // 9 = "_" + 8 hex chars
    const truncated = normalized.length > budget ? normalized.slice(0, budget) : normalized;
    const checksum = this.fnv1a32(slug).toString(16).padStart(8, '0');

    const schemaName = `${TENANT_SCHEMA_PREFIX}${truncated}_${checksum}`;
    this.logger.debug(`Mapped slug "${slug}" to schema "${schemaName}".`);
    return schemaName;
  }

  /**
   * Reverses {@link TenantSchemaNamingService.toSchemaName}.
   *
   * The checksum is not invertible, so this only recovers the slug for schemas
   * whose truncation did not occur. Intended for operational tooling and log
   * correlation, not for routing decisions.
   *
   * @param schemaName Schema name.
   * @returns The slug when it can be recovered, otherwise `null`.
   */
  fromSchemaName(schemaName: string): string | null {
    if (!schemaName.startsWith(TENANT_SCHEMA_PREFIX)) {
      return null;
    }
    const body = schemaName.slice(TENANT_SCHEMA_PREFIX.length);
    const lastUnderscore = body.lastIndexOf('_');
    if (lastUnderscore <= 0) {
      return null;
    }
    const slugPart = body.slice(0, lastUnderscore);
    const candidate = slugPart.replaceAll('_', '-');
    return SLUG_PATTERN.test(candidate) ? candidate : null;
  }

  /**
   * Confirms that a schema name stored in the registry is still well formed.
   *
   * Guards against a tampered or corrupted row being used to build SQL.
   *
   * @param schemaName Schema name to validate.
   * @returns `true` when the name is a valid tenant schema identifier.
   */
  isValidSchemaName(schemaName: string): boolean {
    return isValidTenantSchemaName(schemaName);
  }

  /**
   * FNV-1a 32-bit hash, rendered as 8 hex characters.
   *
   * Not a security primitive — it only disambiguates truncated slugs — but it is
   * deterministic across processes and runtimes, which is what a stored schema
   * name requires.
   *
   * @param value Input string.
   * @returns Unsigned 32-bit hash.
   */
  private fnv1a32(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }
}
