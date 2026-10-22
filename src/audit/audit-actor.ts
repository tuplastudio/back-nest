import { AuditActorType } from '../generated/control-plane/enums';
import type { RequestContext } from '../tenancy/tenant-context.interface';
import type { AuditEntry } from './audit-log.service';

/** The actor columns of an {@link AuditEntry}, plus the request hashes. */
export type AuditActor = Pick<
  AuditEntry,
  'actorType' | 'actorId' | 'actorLabel' | 'ipHash' | 'userAgentHash'
>;

/**
 * Who is acting, as the audit log records it (BN-REQ-OPS-011).
 *
 * A request with no principal (the unsigned Netpay notification, a background
 * worker) is the system. Labels are display names or key names, never an e-mail.
 *
 * @param context The current request context.
 * @returns Actor type, id, label and the request hashes.
 */
export function auditActorOf(
  context: Pick<RequestContext, 'principal' | 'ipHash' | 'userAgentHash'>,
): AuditActor {
  const meta = { ipHash: context.ipHash, userAgentHash: context.userAgentHash };
  const principal = context.principal;
  switch (principal?.kind) {
    case 'platform-admin':
      return {
        actorType: AuditActorType.PLATFORM_ADMIN,
        actorId: principal.id,
        actorLabel: principal.displayName,
        ...meta,
      };
    case 'tenant-user':
      return {
        actorType: AuditActorType.TENANT_USER,
        actorId: principal.id,
        actorLabel: principal.displayName,
        ...meta,
      };
    case 'api-key':
      return {
        actorType: AuditActorType.API_KEY,
        actorId: principal.id,
        actorLabel: principal.name,
        ...meta,
      };
    default:
      return { actorType: AuditActorType.SYSTEM, actorId: null, actorLabel: 'system', ...meta };
  }
}
