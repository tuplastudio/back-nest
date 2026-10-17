import { Injectable, Logger } from '@nestjs/common';
import { MemberRole, MemberStatus } from '../generated/tenant-plane/enums';
import type { UserModel as User } from '../generated/tenant-plane/models/User';
import { AuditActorType, AuditOutcome } from '../generated/control-plane/enums';
import { AuditLogService } from '../audit/audit-log.service';
import { PasswordService } from '../auth/password.service';
import { PiiCryptoService } from '../pii/pii-crypto.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { TokenService } from '../auth/token.service';
import { RequestContextService } from '../tenancy/request-context.service';
import {
  AccountLockedException,
  AuthorizationException,
  ConflictException,
  InvalidCredentialsException,
  NotFoundException,
  TokenReuseDetectedException,
} from '../common/errors/app.exception';

/**
 * Result of a successful tenant member sign-in.
 */
export interface TenantSignInResult {
  /** Signed access token. */
  readonly accessToken: string;
  /** Refresh token, returned once. */
  readonly refreshToken: string;
  /** Access token expiry, epoch milliseconds. */
  readonly accessTokenExpiresAt: number;
  /** Refresh token expiry, epoch milliseconds. */
  readonly refreshTokenExpiresAt: number;
  /** Rotation family identifier. */
  readonly familyId: string;
  /** Digest of the refresh token to persist. */
  readonly refreshTokenDigest: string;
  /** Member id. */
  readonly userId: string;
  /** Masked e-mail, safe to display. */
  readonly emailMasked: string;
  /** Display name. */
  readonly displayName: string;
  /** Tenant-scoped role. */
  readonly role: MemberRole;
}

/**
 * Input for creating a tenant member.
 */
export interface CreateUserInput {
  /** E-mail address; encrypted before storage. */
  readonly email: string;
  /** Optional phone number; encrypted before storage. */
  readonly phone?: string;
  /** Display name. */
  readonly displayName: string;
  /** Initial password; omit for SSO-only accounts. */
  readonly password?: string;
  /** Tenant-scoped role. */
  readonly role?: MemberRole;
}

/**
 * Ordering used to bound which tenant roles a caller may grant.
 *
 * `ApiKeyScopesGuard` deliberately skips member sessions and states that tenant
 * members are authorised by their tenant role *at the service layer*, so this is
 * that decision point.
 */
const MEMBER_ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  [MemberRole.VIEWER]: 0,
  [MemberRole.MEMBER]: 1,
  [MemberRole.ADMIN]: 2,
  [MemberRole.OWNER]: 3,
};

/** System role granted for each member role. `OWNER` is never granted through the API. */
const CATALOG_ROLE_BY_MEMBER_ROLE: Partial<Record<MemberRole, string>> = {
  [MemberRole.ADMIN]: 'tenant-admin',
  [MemberRole.MEMBER]: 'tenant-member',
  [MemberRole.VIEWER]: 'tenant-viewer',
};

/**
 * Password authentication and member management within one tenant.
 *
 * Isolation
 * ---------
 * Every query runs through {@link TenantPrismaService}, so a member of tenant A
 * is structurally unreachable from a request scoped to tenant B: the generated
 * SQL names schema B's tables regardless of the id supplied.
 *
 * PII
 * ---
 * E-mail and phone are stored as AES-256-GCM ciphertext with a keyed HMAC blind
 * index for lookups and a pre-computed masked value for rendering. The plaintext
 * never reaches the database, and responses carry either the masked value or,
 * only for the member's own account, the decrypted original.
 */
@Injectable()
export class TenantUsersService {
  private readonly logger = new Logger(TenantUsersService.name);

  /**
   * @param tenantPrisma Tenant client factory.
   * @param passwords Password hashing service.
   * @param tokens Token issuing service.
   * @param crypto PII crypto service.
   * @param audit Audit trail writer.
   * @param requestContext Request-scoped context holder.
   * @param controlPlane Control-plane client, which holds the role catalogue.
   */
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly crypto: PiiCryptoService,
    private readonly audit: AuditLogService,
    private readonly requestContext: RequestContextService,
    private readonly controlPlane: ControlPlanePrismaService,
  ) {}

  /**
   * Authenticates a tenant member within the current tenant.
   *
   * @param email Submitted e-mail address.
   * @param password Submitted password.
   * @returns The issued token pair and profile summary.
   * @throws {InvalidCredentialsException} On bad credentials or an inactive account.
   * @throws {AccountLockedException} When the account is locked out.
   */
  async signIn(email: string, password: string): Promise<TenantSignInResult> {
    const tenant = this.requestContext.requireTenant();
    const lookup = this.crypto.blindIndex(email);

    // The Argon2 verification runs outside the tenant transaction on purpose: it
    // costs tens of milliseconds of CPU, and holding a pooled connection for that
    // would starve the pool under a burst of sign-ins.
    const user = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.user.findUnique({ where: { emailLookup: lookup } }),
    );
    const verification = await this.passwords.verify(user?.passwordHash ?? null, password);

    if (!user || !verification.valid || user.deletedAt) {
      if (user && !user.deletedAt) {
        await this.registerFailedAttempt(user);
      }
      await this.audit.record({
        tenantId: tenant.id,
        actorType: AuditActorType.SYSTEM,
        action: 'tenant.auth.sign-in',
        resourceType: 'user',
        outcome: AuditOutcome.FAILURE,
        metadata: { emailLookup: lookup },
        ...this.requestMeta(),
      });
      throw new InvalidCredentialsException();
    }

    if (user.status !== MemberStatus.ACTIVE) {
      throw new InvalidCredentialsException();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AccountLockedException(Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000));
    }

    // Rehash outside the transaction for the same CPU reason as above.
    const passwordHash = verification.needsRehash ? await this.passwords.hash(password) : user.passwordHash;
    const pair = this.tokens.issuePair(user.id, 'tenant-user', tenant.id);

    // Sequential inside the interactive transaction, which keeps the pair atomic
    // while sharing the single connection that carries the tenant binding.
    await this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      await client.userRefreshToken.create({
        data: {
          userId: user.id,
          familyId: pair.familyId,
          tokenHash: pair.refreshTokenDigest,
          expiresAt: new Date(pair.refreshTokenExpiresAt),
          ipHash: this.requestContext.get().ipHash,
          userAgentHash: this.requestContext.get().userAgentHash,
        },
      });
      await client.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          lastKnownIpHash: this.requestContext.get().ipHash,
          passwordHash,
        },
      });
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorType: AuditActorType.TENANT_USER,
      actorId: user.id,
      actorLabel: user.displayName,
      action: 'tenant.auth.sign-in',
      resourceType: 'user',
      resourceId: user.id,
      ...this.requestMeta(),
    });

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      familyId: pair.familyId,
      refreshTokenDigest: pair.refreshTokenDigest,
      userId: user.id,
      emailMasked: user.emailMasked,
      displayName: user.displayName,
      role: user.role,
    };
  }

  /**
   * Rotates a member's refresh token.
   *
   * @param refreshToken The presented refresh token.
   * @returns A new token pair.
   * @throws {TokenReuseDetectedException} When a rotated token is replayed.
   */
  async refresh(refreshToken: string): Promise<TenantSignInResult> {
    const tenant = this.requestContext.requireTenant();

    let payload;
    try {
      payload = this.tokens.verifyRefreshToken(refreshToken);
    } catch {
      throw new InvalidCredentialsException();
    }
    if (payload.kind !== 'tenant-user' || (payload.tid && payload.tid !== tenant.id)) {
      throw new InvalidCredentialsException();
    }

    const digest = TokenService.digest(refreshToken);
    const stored = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.userRefreshToken.findUnique({ where: { tokenHash: digest }, include: { user: true } }),
    );

    if (!stored) {
      throw new InvalidCredentialsException();
    }
    if (stored.replacedByTokenHash) {
      await this.tenantPrisma.forCurrentTenantTransaction((client) =>
        client.userRefreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      await this.audit.record({
        tenantId: tenant.id,
        actorType: AuditActorType.SYSTEM,
        action: 'tenant.auth.refresh-reuse-detected',
        resourceType: 'user',
        resourceId: stored.userId,
        outcome: AuditOutcome.DENIED,
        metadata: { familyId: stored.familyId },
        ...this.requestMeta(),
      });
      throw new TokenReuseDetectedException();
    }
    if (stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) {
      throw new InvalidCredentialsException();
    }
    if (stored.user.status !== MemberStatus.ACTIVE || stored.user.deletedAt) {
      throw new InvalidCredentialsException();
    }

    // The family id is the FOURTH argument; see AdminAuthService.refresh.
    const pair = this.tokens.issuePair(stored.userId, 'tenant-user', tenant.id, stored.familyId);

    // Sequential inside one interactive transaction: still atomic, and it keeps
    // both statements on the connection that carries the tenant binding.
    await this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      await client.userRefreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedByTokenHash: pair.refreshTokenDigest },
      });
      await client.userRefreshToken.create({
        data: {
          userId: stored.userId,
          familyId: pair.familyId,
          tokenHash: pair.refreshTokenDigest,
          expiresAt: new Date(pair.refreshTokenExpiresAt),
          ipHash: this.requestContext.get().ipHash,
          userAgentHash: this.requestContext.get().userAgentHash,
        },
      });
    });

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      familyId: pair.familyId,
      refreshTokenDigest: pair.refreshTokenDigest,
      userId: stored.user.id,
      emailMasked: stored.user.emailMasked,
      displayName: stored.user.displayName,
      role: stored.user.role,
    };
  }

  /**
   * Creates a member in the current tenant.
   *
   * Authorises the grant before any write: the caller must be a known principal,
   * `OWNER` is never grantable through this path, and a member may not grant a
   * role above its own. `CreateUserDto` enforces the same two invariants at the
   * edge; keeping both layers means neither a DTO change nor a new controller
   * route can reintroduce the escalation.
   *
   * @param input Member attributes.
   * @returns The created member, with the e-mail masked.
   * @throws {AuthorizationException} When the requested role exceeds the caller's authority.
   * @throws {ConflictException} When the e-mail is already registered.
   */
  async create(input: CreateUserInput): Promise<User> {
    const tenant = this.requestContext.requireTenant();

    const principal = this.requestContext.principal;
    if (!principal) {
      throw new AuthorizationException('A principal is required to create a member.');
    }
    const requestedRole = input.role ?? MemberRole.MEMBER;
    if (requestedRole === MemberRole.OWNER) {
      throw new AuthorizationException('Role OWNER cannot be granted through this endpoint.');
    }
    if (
      principal.kind === 'tenant-user' &&
      MEMBER_ROLE_RANK[requestedRole] > MEMBER_ROLE_RANK[principal.role]
    ) {
      throw new AuthorizationException(
        `Role "${requestedRole}" exceeds the caller's own role "${principal.role}".`,
      );
    }

    const email = PiiCryptoService.normalizeEmail(input.email);
    const lookup = this.crypto.blindIndex(email);

    // Check and insert inside one tenant-scoped transaction so a concurrent
    // create cannot slip between the duplicate probe and the write; the unique
    // index on `emailLookup` remains the real arbiter.
    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;
    const roleId = await this.catalogRoleId(requestedRole);

    const user = await this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      const existing = await client.user.findUnique({ where: { emailLookup: lookup } });
      if (existing) {
        throw new ConflictException('A member with that e-mail address already exists in this tenant.');
      }
      const created = await client.user.create({
        data: {
          emailCiphertext: this.crypto.encrypt(email, { aad: 'tenant-user.email' }),
          emailLookup: lookup,
          emailMasked: this.maskEmail(email),
          phoneCiphertext: input.phone
            ? this.crypto.encrypt(input.phone, { aad: 'tenant-user.phone' })
            : null,
          displayName: input.displayName,
          passwordHash,
          role: requestedRole,
          status: passwordHash ? MemberStatus.ACTIVE : MemberStatus.INVITED,
          createdById: principal.id,
        },
      });
      // Authority comes from the RBAC catalogue, not from the `role` column. A
      // member created without an assignment would hold no permission at all.
      if (roleId !== null) {
        await client.userRole.create({
          data: { userId: created.id, roleId, assignedById: principal.id },
        });
      }
      return created;
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorType: AuditActorType.TENANT_USER,
      actorId: this.requestContext.principal?.id ?? null,
      action: 'tenant.user.created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { role: user.role, status: user.status },
      ...this.requestMeta(),
    });

    return user;
  }

  /**
   * Resolves the system role that backs a member role.
   *
   * @param role Role requested for the member.
   * @returns The catalogue role id, or `null` when the catalogue has no such role.
   */
  private async catalogRoleId(role: MemberRole): Promise<string | null> {
    const name = CATALOG_ROLE_BY_MEMBER_ROLE[role];
    if (name === undefined) {
      return null;
    }
    const row = await this.controlPlane.client.role.findUnique({ where: { name }, select: { id: true } });
    if (row === null) {
      // Fails closed: the member exists but holds no authority until a role is
      // assigned, which is safer than guessing a broader one.
      this.logger.warn(`System role "${name}" is missing from the catalogue; the member holds no role.`);
    }
    return row?.id ?? null;
  }

  /**
   * Lists members of the current tenant.
   *
   * @param filters Filtering and pagination parameters.
   * @returns A page of members.
   */
  async list(filters: { role?: MemberRole; search?: string; limit?: number; cursor?: string }): Promise<{
    items: User[];
    nextCursor: string | null;
    total: number;
  }> {
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);

    const where = {
      deletedAt: null,
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.search ? { displayName: { contains: filters.search, mode: 'insensitive' as const } } : {}),
    };

    // Sequential: both queries share one connection inside the transaction that
    // binds the tenant for row-level security.
    return this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      const rows = await client.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      });
      const total = await client.user.count({ where });
      return {
        items: rows,
        nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
        total,
      };
    });
  }

  /**
   * Returns one member of the current tenant.
   *
   * @param id Member UUID.
   * @returns The member.
   * @throws {NotFoundException} When the member does not exist in this tenant.
   */
  async findById(id: string): Promise<User> {
    const user = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.user.findFirst({ where: { id, deletedAt: null } }),
    );
    if (!user) {
      throw new NotFoundException('User', id);
    }
    return user;
  }

  /**
   * Returns the caller's own decrypted e-mail.
   *
   * This is the one place a plaintext PII value is returned, and only to the
   * principal that owns it. Everything else returns {@link User.emailMasked}.
   *
   * @param userId Member UUID.
   * @returns The decrypted e-mail address.
   * @throws {NotFoundException} When the member does not exist.
   */
  async ownEmail(userId: string): Promise<string> {
    const user = await this.findById(userId);
    return this.crypto.decrypt(user.emailCiphertext, { aad: 'tenant-user.email' });
  }

  /**
   * Revokes every refresh token belonging to a member.
   *
   * @param userId Member UUID.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.userRefreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /**
   * Masks an e-mail for storage and display.
   *
   * @param email Normalised address.
   * @returns The masked representation.
   */
  private maskEmail(email: string): string {
    const [local = '', domain = ''] = email.split('@');
    if (local.length <= 2) {
      return `***@${domain}`;
    }
    return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 8))}${local[local.length - 1]}@${domain}`;
  }

  /**
   * Records a failed sign-in and locks the account once the budget is spent.
   *
   * @param client Tenant-scoped client.
   * @param user The member being attacked.
   */
  private async registerFailedAttempt(user: User): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= 5;

    await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + 15 * 60 * 1000) : user.lockedUntil,
        },
      }),
    );

    if (shouldLock) {
      this.logger.warn(`Locked tenant member ${user.id} after repeated failed sign-in attempts.`);
    }
  }

  /**
   * Audit metadata for the current request.
   *
   * @returns IP and user-agent hashes.
   */
  private requestMeta(): { ipHash: string | null; userAgentHash: string | null } {
    const context = this.requestContext.get();
    return { ipHash: context.ipHash, userAgentHash: context.userAgentHash };
  }
}
