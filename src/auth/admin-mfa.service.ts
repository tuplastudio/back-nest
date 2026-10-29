import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditActorType, AuditOutcome } from '../generated/control-plane/enums';
import { AuditLogService } from '../audit/audit-log.service';
import { AppConfig } from '../config/app-config.service';
import { AppException, ConflictException } from '../common/errors/app.exception';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { PiiCryptoService } from '../pii/pii-crypto.service';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp';
import { isAdminLocked, registerAdminFailedAttempt } from './admin-lockout';

/** AAD binding an MFA secret to its administrator. */
export function mfaSecretAad(adminId: string): string {
  return `platform-admin.mfa:${adminId}`;
}

/** Raised for a wrong second factor; uniform so it reveals nothing. */
export class InvalidMfaCodeException extends AppException {
  constructor() {
    super('The verification code is not valid.', 'INVALID_MFA_CODE', HttpStatus.UNAUTHORIZED);
  }
}

/**
 * TOTP enrolment and verification for platform administrators
 * (BN-REQ-SEC-006).
 *
 * The secret is encrypted with the PII keyring and bound to the admin through
 * the AAD; recovery codes are stored as hashes and consumed on use; an accepted
 * TOTP step is remembered so the same code cannot be replayed.
 */
@Injectable()
export class AdminMfaService {
  private readonly logger = new Logger(AdminMfaService.name);

  constructor(
    private readonly prisma: ControlPlanePrismaService,
    private readonly crypto: PiiCryptoService,
    private readonly audit: AuditLogService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Starts (or restarts) enrolment: stores a fresh, not yet active secret.
   *
   * @param adminId Administrator.
   * @returns The base32 secret and its `otpauth://` URI, shown once.
   * @throws {ConflictException} When MFA is already active.
   */
  async enroll(adminId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const admin = await this.prisma.client.platformAdmin.findUniqueOrThrow({
      where: { id: adminId },
      select: { mfaEnabledAt: true, emailMasked: true },
    });
    if (admin.mfaEnabledAt !== null) {
      throw new ConflictException('A second factor is already active; disable it first to re-enrol.');
    }
    const secret = base32Encode(generateTotpSecret());
    await this.prisma.client.platformAdmin.update({
      where: { id: adminId },
      data: {
        mfaSecretCiphertext: this.crypto.encrypt(secret, { aad: mfaSecretAad(adminId) }),
        mfaLastUsedStep: null,
      },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, admin.emailMasked, this.config.jwtIssuer) };
  }

  /**
   * Confirms enrolment with a first code and issues recovery codes.
   *
   * @param adminId Administrator.
   * @param code TOTP code from the authenticator.
   * @returns Recovery codes, shown once.
   */
  async confirm(adminId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const admin = await this.prisma.client.platformAdmin.findUniqueOrThrow({
      where: { id: adminId },
      select: { mfaEnabledAt: true, mfaSecretCiphertext: true, mfaLastUsedStep: true },
    });
    if (admin.mfaEnabledAt !== null) {
      throw new ConflictException('A second factor is already active.');
    }
    if (admin.mfaSecretCiphertext === null) {
      throw new ConflictException('Start enrolment with POST /auth/mfa/enroll first.');
    }
    const step = verifyTotp(
      this.secretOf(adminId, admin.mfaSecretCiphertext),
      code,
      Date.now(),
      admin.mfaLastUsedStep,
    );
    if (step === null) {
      await this.record(adminId, 'auth.mfa.confirm', AuditOutcome.FAILURE);
      throw new InvalidMfaCodeException();
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.client.platformAdmin.update({
      where: { id: adminId },
      data: {
        mfaEnabledAt: new Date(),
        mfaLastUsedStep: step,
        mfaRecoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
      },
    });
    await this.record(adminId, 'auth.mfa.enabled', AuditOutcome.SUCCESS);
    return { recoveryCodes };
  }

  /**
   * Verifies a TOTP code or consumes a recovery code.
   *
   * A wrong code spends the account's lockout budget (the same counter as a
   * wrong password), and a locked account accepts no code at all, so a six-digit
   * code cannot be brute-forced from any number of IPs or sessions.
   *
   * @param adminId Administrator.
   * @param code TOTP code or recovery code.
   * @param context Request metadata for the lockout audit, when available.
   * @returns `true` when accepted.
   */
  async verify(
    adminId: string,
    code: string,
    context?: { ipHash: string | null; userAgentHash: string | null },
  ): Promise<boolean> {
    const admin = await this.prisma.client.platformAdmin.findUnique({
      where: { id: adminId },
      select: {
        mfaEnabledAt: true,
        mfaSecretCiphertext: true,
        mfaLastUsedStep: true,
        mfaRecoveryCodeHashes: true,
        lockedUntil: true,
      },
    });
    if (!admin || admin.mfaEnabledAt === null || admin.mfaSecretCiphertext === null) {
      return false;
    }
    if (isAdminLocked(admin)) {
      await this.record(adminId, 'auth.mfa.verify', AuditOutcome.DENIED, { reason: 'locked' });
      return false;
    }
    const step = verifyTotp(
      this.secretOf(adminId, admin.mfaSecretCiphertext),
      code,
      Date.now(),
      admin.mfaLastUsedStep,
    );
    if (step !== null) {
      // Conditional on the previous step, so two concurrent uses of one code
      // cannot both succeed.
      const updated = await this.prisma.client.platformAdmin.updateMany({
        where: { id: adminId, mfaLastUsedStep: admin.mfaLastUsedStep },
        data: { mfaLastUsedStep: step },
      });
      return updated.count === 1;
    }
    const hash = hashRecoveryCode(code);
    if (!admin.mfaRecoveryCodeHashes.includes(hash)) {
      await this.record(adminId, 'auth.mfa.verify', AuditOutcome.FAILURE);
      await registerAdminFailedAttempt(
        { prisma: this.prisma, audit: this.audit, config: this.config, logger: this.logger },
        adminId,
        context,
      );
      return false;
    }
    const updated = await this.prisma.client.platformAdmin.updateMany({
      where: { id: adminId, mfaRecoveryCodeHashes: { has: hash } },
      data: { mfaRecoveryCodeHashes: admin.mfaRecoveryCodeHashes.filter((h) => h !== hash) },
    });
    await this.record(adminId, 'auth.mfa.recovery-code-used', AuditOutcome.SUCCESS, {
      remaining: admin.mfaRecoveryCodeHashes.length - 1,
    });
    return updated.count === 1;
  }

  /**
   * Replaces the recovery codes after verifying a code.
   *
   * @param adminId Administrator.
   * @param code Current TOTP or recovery code.
   * @returns The new codes, shown once.
   */
  async regenerateRecoveryCodes(adminId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    if (!(await this.verify(adminId, code))) {
      throw new InvalidMfaCodeException();
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.client.platformAdmin.update({
      where: { id: adminId },
      data: { mfaRecoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) },
    });
    await this.record(adminId, 'auth.mfa.recovery-codes-regenerated', AuditOutcome.SUCCESS);
    return { recoveryCodes };
  }

  /**
   * Turns MFA off after verifying a code.
   *
   * @param adminId Administrator.
   * @param code Current TOTP or recovery code.
   */
  async disable(adminId: string, code: string): Promise<void> {
    if (!(await this.verify(adminId, code))) {
      throw new InvalidMfaCodeException();
    }
    await this.prisma.client.platformAdmin.update({
      where: { id: adminId },
      data: {
        mfaSecretCiphertext: null,
        mfaEnabledAt: null,
        mfaLastUsedStep: null,
        mfaRecoveryCodeHashes: [],
      },
    });
    await this.record(adminId, 'auth.mfa.disabled', AuditOutcome.SUCCESS);
  }

  /**
   * Decrypts the stored secret.
   *
   * @param adminId Administrator, bound through the AAD.
   * @param ciphertext Stored secret.
   * @returns Raw secret bytes.
   */
  private secretOf(adminId: string, ciphertext: string): Buffer {
    return base32Decode(this.crypto.decrypt(ciphertext, { aad: mfaSecretAad(adminId) }));
  }

  private async record(
    adminId: string,
    action: string,
    outcome: AuditOutcome,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      tenantId: null,
      actorType: AuditActorType.PLATFORM_ADMIN,
      actorId: adminId,
      action,
      resourceType: 'platform-admin',
      resourceId: adminId,
      outcome,
      ...(metadata ? { metadata } : {}),
    });
  }
}
