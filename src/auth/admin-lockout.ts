import type { Logger } from '@nestjs/common';
import { AuditActorType, AuditOutcome } from '../generated/control-plane/enums';
import type { AuditLogService } from '../audit/audit-log.service';
import type { AppConfig } from '../config/app-config.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';

/**
 * Per-account lockout of a platform administrator, shared by the password
 * (sign-in, password change) and the second factor (`/auth/mfa/*`): both spend
 * the same `failedLoginAttempts` budget, so neither can be brute-forced on its
 * own, and spreading the guesses over many IPs does not help either.
 */

/** What {@link registerAdminFailedAttempt} needs. */
export interface AdminLockoutDeps {
  readonly prisma: ControlPlanePrismaService;
  readonly audit: AuditLogService;
  readonly config: Pick<AppConfig, 'authMaxFailedAttempts' | 'authLockoutDurationMs'>;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Whether the account is locked right now.
 *
 * @param admin Lock column of the account.
 * @returns `true` while `lockedUntil` is in the future.
 */
export function isAdminLocked(admin: { lockedUntil: Date | null }): boolean {
  return admin.lockedUntil !== null && admin.lockedUntil.getTime() > Date.now();
}

/**
 * Counts a failure and locks the account once the budget is spent.
 *
 * The counter is incremented in the database, never computed from a row read
 * earlier: concurrent failures would otherwise overwrite each other and the
 * budget would never run out. The lock is a conditional update on the counter,
 * so of several requests crossing the threshold together exactly one locks (and
 * audits); locking resets the counter for the next window.
 *
 * @param deps Collaborators.
 * @param adminId The account being attacked.
 * @param context Request metadata, when there is a request.
 * @returns `true` when this failure locked the account.
 */
export async function registerAdminFailedAttempt(
  deps: AdminLockoutDeps,
  adminId: string,
  context: { ipHash: string | null; userAgentHash: string | null } | undefined,
): Promise<boolean> {
  const max = deps.config.authMaxFailedAttempts;
  const counted = await deps.prisma.client.platformAdmin.update({
    where: { id: adminId },
    data: {
      failedLoginAttempts: { increment: 1 },
      ...(context?.ipHash ? { lastKnownIpHash: context.ipHash } : {}),
    },
    select: { failedLoginAttempts: true },
  });
  if (counted.failedLoginAttempts < max) {
    return false;
  }
  const locked = await deps.prisma.client.platformAdmin.updateMany({
    where: { id: adminId, failedLoginAttempts: { gte: max } },
    data: { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + deps.config.authLockoutDurationMs) },
  });
  if (locked.count === 0) {
    return false;
  }
  deps.logger.warn(`Locked platform admin ${adminId} after repeated failed authentication attempts.`);
  await deps.audit.record({
    tenantId: null,
    actorType: AuditActorType.SYSTEM,
    action: 'auth.account-locked',
    resourceType: 'platform-admin',
    resourceId: adminId,
    outcome: AuditOutcome.DENIED,
    ipHash: context?.ipHash ?? null,
    userAgentHash: context?.userAgentHash ?? null,
    metadata: {
      attempts: counted.failedLoginAttempts,
      lockoutSeconds: Math.round(deps.config.authLockoutDurationMs / 1000),
    },
  });
  return true;
}
