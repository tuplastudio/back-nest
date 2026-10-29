import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, AuditOutcome, PlatformRole } from '../generated/control-plane/enums';
import { AuditLogService } from '../audit/audit-log.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { AppConfig } from '../config/app-config.service';
import {
  ConflictException,
  InvalidCredentialsException,
  TokenReuseDetectedException,
} from '../common/errors/app.exception';
import { PiiCryptoService } from '../pii/pii-crypto.service';
import { AdminMfaService, InvalidMfaCodeException } from './admin-mfa.service';
import { isAdminLocked, registerAdminFailedAttempt } from './admin-lockout';

/**
 * Context about the calling client, captured for the audit trail.
 */
export interface SignInContext {
  /** Client IP, hashed before storage. */
  readonly ipHash: string | null;
  /** SHA-256 of the user agent. */
  readonly userAgentHash: string | null;
  /** Correlation id for the request. */
  readonly requestId: string;
}

/**
 * Result of a successful platform administrator sign-in.
 */
export interface SignInResult {
  /** Signed access token. */
  readonly accessToken: string;
  /** Refresh token, returned once and rotated thereafter. */
  readonly refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  readonly accessTokenExpiresAt: number;
  /** Epoch milliseconds when the refresh token expires. */
  readonly refreshTokenExpiresAt: number;
  /** Rotation family of the refresh token. */
  readonly familyId: string;
  /** Digest of the refresh token to persist. */
  readonly refreshTokenDigest: string;
  /** Masked e-mail, safe to display. */
  readonly emailMasked: string;
  /** Display name. */
  readonly displayName: string;
  /** Platform role. */
  readonly role: PlatformRole;
  /** Whether a password change is mandatory. */
  readonly mustChangePassword: boolean;
  /**
   * Whether the session still owes a second factor: MFA is enrolled but was
   * not verified, or it is required and not enrolled yet (BN-REQ-SEC-006).
   */
  readonly mfaRequired: boolean;
}

/**
 * Password authentication and session lifecycle for platform administrators.
 *
 * Brute force protection
 * ----------------------
 * Two independent layers:
 *  1. **Per-account lockout.** After `AUTH_MAX_FAILED_ATTEMPTS` consecutive
 *     failures the account is locked for `AUTH_LOCKOUT_DURATION`. The counter is
 *     stored on the row, so a distributed attack against one account still hits
 *     the limit.
 *  2. **Per-IP throttling.** Applied declaratively on the route with
 *     `@Throttle`, which caps the aggregate rate regardless of how many accounts
 *     are targeted.
 *
 * Failure responses are deliberately uniform: unknown e-mail, wrong password and
 * locked account all produce a message that does not reveal which condition
 * applied, so the endpoint cannot be used to enumerate accounts.
 *
 * Refresh token rotation
 * ----------------------
 * Every refresh exchanges the presented token for a new one and marks the old one
 * as rotated. If an already-rotated token is presented again, that is strong
 * evidence the token was stolen, so the entire rotation family is revoked and
 * every session for that administrator is terminated.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  /**
   * @param prisma Control-plane Prisma service.
   * @param passwords Password hashing service.
   * @param tokens Token issuing and verification service.
   * @param audit Audit trail writer.
   * @param crypto PII crypto service (blind indexes, IP hashing).
   * @param config Validated application configuration.
   */
  constructor(
    private readonly prisma: ControlPlanePrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditLogService,
    private readonly crypto: PiiCryptoService,
    private readonly config: AppConfig,
    private readonly mfa: AdminMfaService,
  ) {}

  /**
   * Authenticates a platform administrator with e-mail and password.
   *
   * @param email Submitted e-mail address (normalised before lookup).
   * @param password Submitted password.
   * @param context Request metadata for the audit trail.
   * @param secondFactor Optional TOTP or recovery code; when valid the session
   * is MFA-verified from the start.
   * @returns The issued token pair and profile fields.
   * @throws {InvalidCredentialsException} On bad credentials, or while the
   * account is locked: the lock is checked before the password, so a locked
   * account answers the same 401 whatever password is sent.
   * @throws {InvalidMfaCodeException} When a second factor is sent and is wrong.
   */
  async signIn(
    email: string,
    password: string,
    context: SignInContext,
    secondFactor?: string,
  ): Promise<SignInResult> {
    const normalized = PiiCryptoService.normalizeEmail(email);
    const lookup = this.crypto.blindIndex(normalized);

    const admin = await this.prisma.client.platformAdmin.findUnique({
      where: { emailLookup: lookup },
    });

    // The lock is decided before the password is looked at: otherwise a locked
    // account would still tell a right password from a wrong one. A locked or
    // unknown account is verified against the dummy hash, so every path costs
    // the same amount of CPU.
    const locked = admin !== null && isAdminLocked(admin);
    const verification = await this.passwords.verify(locked ? null : (admin?.passwordHash ?? null), password);

    if (!admin || locked || !verification.valid) {
      if (admin && !locked) {
        await this.registerFailedAttempt(admin.id, context);
      }
      await this.audit.record({
        tenantId: null,
        actorType: AuditActorType.SYSTEM,
        action: 'auth.sign-in',
        resourceType: 'platform-admin',
        outcome: locked ? AuditOutcome.DENIED : AuditOutcome.FAILURE,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        // The e-mail is hashed, never stored, so the attempt is still traceable
        // without recording PII.
        metadata: { emailLookup: lookup, ...(locked ? { reason: 'locked' } : {}) },
      });
      throw new InvalidCredentialsException();
    }

    // A locked account is reported as invalid credentials so the response does
    // not confirm the account exists.
    if (admin.status !== 'ACTIVE') {
      await this.audit.record({
        tenantId: null,
        actorType: AuditActorType.SYSTEM,
        action: 'auth.sign-in',
        resourceType: 'platform-admin',
        resourceId: admin.id,
        outcome: AuditOutcome.DENIED,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { reason: 'account_not_active' },
      });
      throw new InvalidCredentialsException();
    }

    // Opportunistic hash upgrade: if the cost parameters increased since the
    // password was set, re-hash it now using the fresh password.
    const passwordHash = verification.needsRehash ? await this.passwords.hash(password) : admin.passwordHash;

    let mfaAt: number | undefined;
    if (secondFactor !== undefined && admin.mfaEnabledAt !== null) {
      if (!(await this.mfa.verify(admin.id, secondFactor, context))) {
        // A wrong second factor counts towards lockout like a wrong password;
        // AdminMfaService.verify records it, for every route that checks a code.
        throw new InvalidMfaCodeException();
      }
      mfaAt = Math.floor(Date.now() / 1000);
    }

    const pair = this.tokens.issuePair(admin.id, 'platform-admin', undefined, undefined, mfaAt);

    await this.prisma.client.$transaction([
      this.prisma.client.adminRefreshToken.create({
        data: {
          adminId: admin.id,
          familyId: pair.familyId,
          tokenHash: pair.refreshTokenDigest,
          expiresAt: new Date(pair.refreshTokenExpiresAt),
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
        },
      }),
      this.prisma.client.platformAdmin.update({
        where: { id: admin.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          lastKnownIpHash: context.ipHash,
          passwordHash,
        },
      }),
    ]);

    await this.audit.record({
      tenantId: null,
      actorType: AuditActorType.PLATFORM_ADMIN,
      actorId: admin.id,
      actorLabel: admin.displayName,
      action: 'auth.sign-in',
      resourceType: 'platform-admin',
      resourceId: admin.id,
      outcome: AuditOutcome.SUCCESS,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      familyId: pair.familyId,
      refreshTokenDigest: pair.refreshTokenDigest,
      emailMasked: admin.emailMasked,
      displayName: admin.displayName,
      role: admin.role,
      mustChangePassword: admin.mustChangePassword,
      mfaRequired: this.owesMfa(admin.mfaEnabledAt !== null, mfaAt),
    };
  }

  /**
   * Exchanges a refresh token for a new pair, rotating the token.
   *
   * @param refreshToken The refresh token issued previously.
   * @param context Request metadata for the audit trail.
   * @returns The new token pair.
   * @throws {InvalidCredentialsException} When the token is unknown or expired.
   * @throws {TokenReuseDetectedException} When a rotated token is replayed.
   */
  async refresh(refreshToken: string, context: SignInContext): Promise<SignInResult> {
    let payload;
    try {
      payload = this.tokens.verifyRefreshToken(refreshToken);
    } catch {
      throw new InvalidCredentialsException();
    }

    if (payload.kind !== 'platform-admin') {
      throw new InvalidCredentialsException();
    }

    const digest = TokenService.digest(refreshToken);
    const stored = await this.prisma.client.adminRefreshToken.findUnique({
      where: { tokenHash: digest },
      include: { admin: true },
    });

    if (!stored) {
      throw new InvalidCredentialsException();
    }

    // Replay of an already-rotated token: assume theft and drop the family.
    if (stored.replacedByTokenHash) {
      await this.revokeFamily(stored.familyId);
      await this.audit.record({
        tenantId: null,
        actorType: AuditActorType.SYSTEM,
        action: 'auth.refresh-reuse-detected',
        resourceType: 'platform-admin',
        resourceId: stored.adminId,
        outcome: AuditOutcome.DENIED,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { familyId: stored.familyId },
      });
      throw new TokenReuseDetectedException();
    }

    if (stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) {
      throw new InvalidCredentialsException();
    }

    if (stored.admin.status !== 'ACTIVE') {
      throw new InvalidCredentialsException();
    }

    // The family id is the FOURTH argument: passing it in the tenantId position
    // would start a new rotation family on every refresh, defeating reuse detection.
    // The verification time travels with the family: a refreshed session stays
    // verified, but never looks recently verified for a step-up.
    const pair = this.tokens.issuePair(
      stored.adminId,
      'platform-admin',
      undefined,
      stored.familyId,
      payload.mfa,
    );

    // Revoke the presented token and link it to its replacement, all in one
    // transaction so a crash cannot leave the old token usable.
    await this.prisma.client.$transaction([
      this.prisma.client.adminRefreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedByTokenHash: pair.refreshTokenDigest },
      }),
      this.prisma.client.adminRefreshToken.create({
        data: {
          adminId: stored.adminId,
          familyId: pair.familyId,
          tokenHash: pair.refreshTokenDigest,
          expiresAt: new Date(pair.refreshTokenExpiresAt),
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
        },
      }),
    ]);

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      familyId: pair.familyId,
      refreshTokenDigest: pair.refreshTokenDigest,
      emailMasked: stored.admin.emailMasked,
      displayName: stored.admin.displayName,
      role: stored.admin.role,
      mustChangePassword: stored.admin.mustChangePassword,
      mfaRequired: this.owesMfa(stored.admin.mfaEnabledAt !== null, payload.mfa),
    };
  }

  /**
   * Starts a fresh session (new rotation family) for an already authenticated
   * administrator, e.g. after a second-factor verification or a password change.
   *
   * @param adminId Administrator.
   * @param context Request metadata.
   * @param mfaAt Epoch seconds of the MFA verification to embed, if any.
   * @returns The new token pair and profile fields.
   */
  async issueSession(
    adminId: string,
    context: SignInContext,
    mfaAt: number | undefined,
  ): Promise<SignInResult> {
    const admin = await this.prisma.client.platformAdmin.findUniqueOrThrow({ where: { id: adminId } });
    const pair = this.tokens.issuePair(admin.id, 'platform-admin', undefined, undefined, mfaAt);
    await this.prisma.client.adminRefreshToken.create({
      data: {
        adminId: admin.id,
        familyId: pair.familyId,
        tokenHash: pair.refreshTokenDigest,
        expiresAt: new Date(pair.refreshTokenExpiresAt),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    });
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      familyId: pair.familyId,
      refreshTokenDigest: pair.refreshTokenDigest,
      emailMasked: admin.emailMasked,
      displayName: admin.displayName,
      role: admin.role,
      mustChangePassword: admin.mustChangePassword,
      mfaRequired: this.owesMfa(admin.mfaEnabledAt !== null, mfaAt),
    };
  }

  /**
   * Changes an administrator's password (BN-REQ-SEC-008).
   *
   * Clears `mustChangePassword`, revokes every other session and returns a new
   * one that keeps the caller's MFA verification.
   *
   * @param adminId Administrator.
   * @param currentPassword Password in use.
   * @param newPassword Replacement.
   * @param context Request metadata.
   * @param mfaAt MFA verification carried by the calling session.
   * @returns The new session.
   * @throws {InvalidCredentialsException} When the current password is wrong.
   */
  async changePassword(
    adminId: string,
    currentPassword: string,
    newPassword: string,
    context: SignInContext,
    mfaAt: number | undefined,
  ): Promise<SignInResult> {
    const admin = await this.prisma.client.platformAdmin.findUniqueOrThrow({ where: { id: adminId } });
    // Same rule as sign-in: a locked account is not asked about its password.
    const locked = isAdminLocked(admin);
    const verification = await this.passwords.verify(locked ? null : admin.passwordHash, currentPassword);
    if (locked || !verification.valid) {
      if (!locked) {
        await this.registerFailedAttempt(admin.id, context);
      }
      throw new InvalidCredentialsException();
    }
    if (currentPassword === newPassword) {
      throw new ConflictException('The new password must differ from the current one.');
    }
    await this.prisma.client.platformAdmin.update({
      where: { id: adminId },
      data: {
        passwordHash: await this.passwords.hash(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
      },
    });
    await this.revokeAllSessions(adminId);
    await this.audit.record({
      tenantId: null,
      actorType: AuditActorType.PLATFORM_ADMIN,
      actorId: adminId,
      action: 'auth.password-changed',
      resourceType: 'platform-admin',
      resourceId: adminId,
      outcome: AuditOutcome.SUCCESS,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });
    return this.issueSession(adminId, context, mfaAt);
  }

  /**
   * Whether a session still owes a second factor.
   *
   * @param enrolled MFA is active for the admin.
   * @param mfaAt Verification carried by the session.
   * @returns `true` when the session must still verify or enrol.
   */
  private owesMfa(enrolled: boolean, mfaAt: number | undefined): boolean {
    return (enrolled || this.config.mfaRequiredForAdmins) && mfaAt === undefined;
  }

  /**
   * Revokes every refresh token in a rotation family.
   *
   * @param familyId Family identifier.
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.client.adminRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Signs every administrator out of every session.
   *
   * @param adminId Administrator primary key.
   */
  async revokeAllSessions(adminId: string): Promise<void> {
    await this.prisma.client.adminRefreshToken.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Records a failed attempt and locks the account once the budget is spent.
   *
   * @param adminId The account being attacked.
   * @param context Request metadata.
   */
  private async registerFailedAttempt(adminId: string, context: SignInContext): Promise<void> {
    await registerAdminFailedAttempt(
      { prisma: this.prisma, audit: this.audit, config: this.config, logger: this.logger },
      adminId,
      context,
    );
  }
}
