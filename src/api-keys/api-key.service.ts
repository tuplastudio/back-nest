import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { ApiKeyStatus, AuditActorType } from '../generated/control-plane/enums';
import type { ApiKeyModel as ApiKey } from '../generated/control-plane/models/ApiKey';
import { AuditLogService } from '../audit/audit-log.service';
import { AppConfig } from '../config/app-config.service';
import { AuthorizationException, ConflictException, NotFoundException } from '../common/errors/app.exception';
import { AuthorizationService } from '../auth/authorization.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { RequestContextService } from '../tenancy/request-context.service';

/**
 * Scopes an operator may grant to an API key.
 *
 * An allow-list rather than free-form strings: an unrecognised scope would
 * silently never match anything, which is worse than a rejected one because the
 * key looks valid in listings.
 */
export const GRANTABLE_SCOPES = [
  'projects:read',
  'projects:write',
  'users:read',
  'users:write',
  'audit:read',
  // A platform integration (a storefront or back office) charges through the API with
  // a key instead of a member session. `payments:configure` is deliberately not
  // grantable: an account's Netpay keys are set by its operator, never by a runtime key.
  'payments:read',
  'payments:write',
  'payments:refund',
  // Outbound webhook endpoints (BN-REQ-SEC-001). Every `/t/webhooks*` route
  // declares one of these, so a key without them is refused there. Secret
  // rotation and replay are mutations and require `webhooks:write`.
  'webhooks:read',
  'webhooks:write',
  // Key management through the API. Grantable by a platform administrator only
  // (see ApiKeyService.assertCallerMayGrant): no member role holds it as a permission.
  'admin:*',
] as const;

/** The key-management scope, which only a platform administrator may grant. */
const ADMIN_SCOPE = 'admin:*';

/** A scope that may be granted to an API key. */
export type GrantableScope = (typeof GRANTABLE_SCOPES)[number];

/**
 * Result of issuing an API key.
 */
export interface IssuedApiKey {
  /** The persisted metadata row. */
  readonly key: ApiKey;
  /**
   * The complete key, e.g. `mtb_live_a1b2c3d4_<secret>`.
   *
   * Returned exactly once, at creation or rotation time. It cannot be recovered
   * afterwards because only an Argon2id hash is stored.
   */
  readonly secret: string;
}

/**
 * Issues, verifies, rotates and revokes per-tenant API keys.
 *
 * Security model
 * --------------
 * * **Secret format** — `<prefix>_<publicPart>_<secretPart>`. The public part is
 *   16 hex characters, indexed and unique per tenant, and locates the candidate
 *   row in O(log n). The secret part is 32 random bytes base64url encoded: 256
 *   bits of entropy, so guessing is infeasible regardless of hashing.
 * * **Storage** — only an Argon2id hash of the secret part is persisted. A
 *   database leak therefore does not yield usable keys, and the fast indexed
 *   public part is useless without the secret.
 * * **Timing** — verifying an unknown public part still performs an Argon2
 *   verification against a dummy hash, so an attacker cannot enumerate valid
 *   prefixes by measuring response time.
 * * **Rotation** — {@link ApiKeyService.rotate} mints a new secret, revokes the
 *   predecessor and links them, so an audit trail shows the chain.
 * * **Metadata in the control plane** — key rows live in `public`, outside any
 *   tenant schema, so a suspended or deleted tenant's keys can still be revoked.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  /** Number of hex characters in the public (indexed) part of a key. */
  private static readonly PUBLIC_PART_BYTES = 8;

  /**
   * Argon2id hash of a random value, used to equalise timing on misses.
   * Computed lazily because the Argon2 API is asynchronous.
   */
  private dummyHashPromise: Promise<string> | null = null;

  /**
   * @param prisma Control-plane Prisma service.
   * @param config Validated application configuration.
   * @param audit Audit trail writer.
   * @param requestContext Request-scoped context holder.
   * @param authorization Resolves the calling member's or admin's permissions.
   */
  constructor(
    private readonly prisma: ControlPlanePrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditLogService,
    private readonly requestContext: RequestContextService,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * Issues a new API key for a tenant.
   *
   * @param tenantId Tenant that owns the key.
   * @param name Operator-facing label.
   * @param scopes Scopes to grant.
   * @param expiresAt Absolute expiry, or `null` for the configured default.
   * @param createdBy Actor recorded as the creator.
   * @returns The metadata row and the one-time clear-text secret.
   * @throws {ConflictException} When a scope is not grantable.
   * @throws {AuthorizationException} When the caller does not hold a requested scope itself.
   */
  async issue(
    tenantId: string,
    name: string,
    scopes: string[],
    expiresAt: Date | null,
    createdBy: { type: AuditActorType; id: string | null },
  ): Promise<IssuedApiKey> {
    this.assertGrantableScopes(scopes);
    await this.assertCallerMayGrant(scopes);

    const publicPart = randomBytes(ApiKeyService.PUBLIC_PART_BYTES).toString('hex');
    const secretPart = randomBytes(32).toString('base64url');
    const prefix = `${this.config.apiKeyPrefix}_${publicPart}`;

    const expiry = expiresAt ?? new Date(Date.now() + this.config.apiKeyDefaultTtlMs);
    const secretHash = await this.hashSecret(secretPart);

    const row = await this.prisma.client.apiKey.create({
      data: {
        tenantId,
        name,
        prefix,
        secretHash,
        scopes,
        expiresAt: expiry,
        createdByType: createdBy.type,
        createdById: createdBy.id,
      },
    });

    await this.audit.record({
      tenantId,
      actorType: createdBy.type,
      actorId: createdBy.id,
      action: 'apikey.create',
      resourceType: 'api-key',
      resourceId: row.id,
      // The secret is deliberately absent: audit logs are read by more people
      // than the key holder.
      metadata: { name, prefix, scopes, expiresAt: expiry.toISOString() },
      ...this.requestMeta(),
    });

    this.logger.log(`Issued API key "${prefix}" for tenant ${tenantId}.`);
    return { key: row, secret: `${prefix}_${secretPart}` };
  }

  /**
   * Lists a tenant's keys without exposing any secret material.
   *
   * @param tenantId Tenant whose keys to list.
   * @param includeRevoked Whether to include revoked and expired keys.
   * @returns The key metadata rows.
   */
  async list(tenantId: string, includeRevoked = false): Promise<ApiKey[]> {
    return this.prisma.client.apiKey.findMany({
      where: {
        tenantId,
        ...(includeRevoked ? {} : { status: ApiKeyStatus.ACTIVE }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revokes an API key.
   *
   * @param tenantId Owning tenant.
   * @param apiKeyId Key to revoke.
   * @returns The updated row.
   * @throws {NotFoundException} When the key does not belong to the tenant.
   */
  async revoke(tenantId: string, apiKeyId: string): Promise<ApiKey> {
    const existing = await this.prisma.client.apiKey.findFirst({
      where: { id: apiKeyId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('API key', apiKeyId);
    }
    if (existing.status === ApiKeyStatus.REVOKED) {
      return existing;
    }

    const updated = await this.prisma.client.apiKey.update({
      where: { id: apiKeyId },
      data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date() },
    });

    await this.audit.record({
      tenantId,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      action: 'apikey.revoke',
      resourceType: 'api-key',
      resourceId: apiKeyId,
      metadata: { prefix: existing.prefix, name: existing.name },
      ...this.requestMeta(),
    });

    return updated;
  }

  /**
   * Rotates an API key: revokes the old secret and issues a new one.
   *
   * Rotation is the mechanism for handling a leak without downtime — callers
   * migrate to the new key, then the old one is revoked.
   *
   * @param tenantId Owning tenant.
   * @param apiKeyId Key to rotate.
   * @returns The new key row and its one-time secret.
   * @throws {NotFoundException} When the key does not exist or is not active.
   * @throws {AuthorizationException} When the key holds a scope the caller does not.
   */
  async rotate(tenantId: string, apiKeyId: string): Promise<IssuedApiKey> {
    const existing = await this.prisma.client.apiKey.findFirst({
      where: { id: apiKeyId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('API key', apiKeyId);
    }
    if (existing.status !== ApiKeyStatus.ACTIVE) {
      throw new ConflictException(`Only active API keys can be rotated (current: ${existing.status}).`);
    }
    // Rotation hands out a fresh secret for the key's scopes: the same as minting it.
    await this.assertCallerMayGrant(existing.scopes);

    const publicPart = randomBytes(ApiKeyService.PUBLIC_PART_BYTES).toString('hex');
    const secretPart = randomBytes(32).toString('base64url');
    const prefix = `${this.config.apiKeyPrefix}_${publicPart}`;

    const created = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.apiKey.create({
        data: {
          tenantId,
          name: existing.name,
          prefix,
          secretHash: await this.hashSecret(secretPart),
          scopes: existing.scopes,
          expiresAt: existing.expiresAt,
          rotatedFromId: existing.id,
          createdByType: this.currentActorType(),
          createdById: this.currentActorId(),
        },
      });
      // The predecessor is revoked in the same transaction, so a crash cannot
      // leave two active secrets for one logical key.
      await tx.apiKey.update({
        where: { id: existing.id },
        data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date() },
      });
      return row;
    });

    await this.audit.record({
      tenantId,
      actorType: this.currentActorType(),
      actorId: this.currentActorId(),
      action: 'apikey.rotate',
      resourceType: 'api-key',
      resourceId: created.id,
      metadata: { previousKeyId: existing.id, newPrefix: prefix },
      ...this.requestMeta(),
    });

    this.logger.log(`Rotated API key for tenant ${tenantId}; new prefix ${prefix}.`);
    return { key: created, secret: `${prefix}_${secretPart}` };
  }

  /**
   * Verifies a secret against a stored hash.
   *
   * @param hash Stored Argon2id hash.
   * @param secret Candidate secret part.
   * @returns `true` when the secret matches.
   */
  async verifySecret(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  }

  /**
   * Burns the same CPU time as a real verification.
   *
   * Called when the public prefix is unknown so response timing cannot be used
   * to discover which prefixes exist.
   *
   * @param secret The presented secret, used as the Argon2 input.
   */
  async equaliseTiming(secret: string): Promise<void> {
    this.dummyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'), this.hashOptions());
    await argon2.verify(await this.dummyHashPromise, secret).catch(() => false);
  }

  /**
   * Argon2id options for hashing an API key secret.
   *
   * @returns Cost parameters for a new key hash.
   */
  hashOptions(): argon2.HashOptions {
    return {
      type: argon2.argon2id,
      memoryCost: this.config.apiKeyArgon2MemoryCost,
      timeCost: this.config.apiKeyArgon2TimeCost,
      parallelism: 1,
    };
  }

  /**
   * Records that a key was used.
   *
   * @param apiKeyId Key that authenticated the request.
   * @param ipHash Keyed hash of the client IP.
   */
  async touchUsage(apiKeyId: string, ipHash: string | null): Promise<void> {
    await this.prisma.client.apiKey.update({
      where: { id: apiKeyId },
      data: {
        lastUsedAt: new Date(),
        lastUsedIpHash: ipHash,
        usageCount: { increment: 1 },
      },
    });
  }

  /**
   * Marks expired keys so listings stop presenting them as active.
   *
   * Called by a scheduled maintenance task; verification also checks
   * `expiresAt` independently, so a stale status can never grant access.
   *
   * @returns The number of keys transitioned.
   */
  async expireOverdue(): Promise<number> {
    const result = await this.prisma.client.apiKey.updateMany({
      where: { status: ApiKeyStatus.ACTIVE, expiresAt: { lte: new Date() } },
      data: { status: ApiKeyStatus.EXPIRED },
    });
    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} API keys as expired.`);
    }
    return result.count;
  }

  /**
   * Revokes every key belonging to a tenant.
   *
   * Called when a tenant is suspended or deleted, so a compromised integration
   * loses access immediately rather than at key expiry.
   *
   * @param tenantId Tenant whose keys must be revoked.
   * @returns The number of keys revoked.
   */
  async revokeAllForTenant(tenantId: string): Promise<number> {
    const result = await this.prisma.client.apiKey.updateMany({
      where: { tenantId, status: ApiKeyStatus.ACTIVE },
      data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date() },
    });

    if (result.count > 0) {
      await this.audit.record({
        tenantId,
        actorType: this.currentActorType(),
        actorId: this.currentActorId(),
        action: 'apikey.revoke-all',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: { revokedCount: result.count },
        ...this.requestMeta(),
      });
    }
    return result.count;
  }

  /**
   * Computes the public prefix for a tenant-scoped key.
   *
   * Exposed for tests and for tooling that needs to render a masked key.
   *
   * @param publicPart The public hex segment.
   * @returns The full indexed prefix.
   */
  buildPrefix(publicPart: string): string {
    return `${this.config.apiKeyPrefix}_${publicPart}`;
  }

  /**
   * Hashes a secret with Argon2id using the API key cost parameters.
   *
   * @param secret Secret part of the key.
   * @returns PHC-formatted hash.
   */
  private hashSecret(secret: string): Promise<string> {
    return argon2.hash(secret, this.hashOptions());
  }

  /**
   * Rejects scopes outside {@link GRANTABLE_SCOPES}.
   *
   * @param scopes Requested scopes.
   * @throws {ConflictException} When any scope is not grantable.
   */
  private assertGrantableScopes(scopes: string[]): void {
    const invalid = scopes.filter((scope) => !GRANTABLE_SCOPES.includes(scope as GrantableScope));
    if (invalid.length > 0) {
      throw new ConflictException(
        `Unsupported scope(s): ${invalid.join(', ')}. Grantable scopes: ${GRANTABLE_SCOPES.join(', ')}.`,
      );
    }
  }

  /**
   * Refuses a scope the caller does not hold itself, so a credential can never
   * be worth more than the principal that minted it.
   *
   *  * A member or platform admin needs the RBAC permission of the same name
   *    (scopes and permissions share the catalogue vocabulary). A tenant ADMIN,
   *    whose role deliberately lacks `webhooks:*`, cannot launder that authority
   *    through a key.
   *  * `admin:*` is not a permission: only a platform administrator grants it.
   *  * An API key (holding `admin:*`) only passes on scopes it holds, and never
   *    `admin:*` itself, so keys cannot breed more powerful keys.
   *
   * @param scopes Scopes the new (or rotated) key would carry.
   * @throws {AuthorizationException} When any scope exceeds the caller's own.
   */
  private async assertCallerMayGrant(scopes: readonly string[]): Promise<void> {
    const principal = this.requestContext.principal;
    if (principal === null || principal === undefined) {
      throw new AuthorizationException('Authentication required.');
    }
    let held: (scope: string) => boolean;
    if (principal.kind === 'api-key') {
      held = (scope) => scope !== ADMIN_SCOPE && principal.scopes.includes(scope);
    } else {
      const { permissions } = await this.authorization.resolve(principal);
      held = (scope) =>
        scope === ADMIN_SCOPE ? principal.kind === 'platform-admin' : permissions.has(scope);
    }
    const beyond = scopes.filter((scope) => !held(scope));
    if (beyond.length > 0) {
      throw new AuthorizationException(`You cannot grant scope(s) you do not hold: ${beyond.join(', ')}.`, {
        scopes: beyond,
      });
    }
  }

  /**
   * Returns audit metadata for the current request.
   *
   * @returns IP and user-agent hashes.
   */
  private requestMeta(): { ipHash: string | null; userAgentHash: string | null } {
    const context = this.requestContext.get();
    return { ipHash: context.ipHash, userAgentHash: context.userAgentHash };
  }

  /**
   * Current actor type from the request context.
   *
   * @returns The actor type, defaulting to `SYSTEM`.
   */
  private currentActorType(): AuditActorType {
    return this.requestContext.principal?.kind === 'tenant-user'
      ? AuditActorType.TENANT_USER
      : this.requestContext.principal?.kind === 'platform-admin'
        ? AuditActorType.PLATFORM_ADMIN
        : AuditActorType.SYSTEM;
  }

  /**
   * Current actor id from the request context.
   *
   * @returns The actor id, or `null`.
   */
  private currentActorId(): string | null {
    return this.requestContext.principal?.id ?? null;
  }
}

/**
 * Computes the SHA-256 digest of a string.
 *
 * Used by tooling that needs to correlate a token with an audit entry without
 * storing the token itself.
 *
 * @param value Input string.
 * @returns Hex digest.
 */
export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
