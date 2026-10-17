import { type TenantStatus } from '../generated/control-plane/enums';

/**
 * Tenant record as resolved from the registry, containing only the fields the
 * request pipeline needs.
 *
 * This narrow shape is deliberate: controllers and guards receive exactly this,
 * never a raw Prisma row, so a column added to the `tenants` table cannot leak
 * into the request context by accident.
 */
export interface TenantContext {
  /** Tenant primary key (UUID). */
  readonly id: string;
  /** URL-safe business identifier. */
  readonly slug: string;
  /** Display name. */
  readonly name: string;
  /** Physical PostgreSQL schema holding this tenant's data. */
  readonly schemaName: string;
  /** Current lifecycle state. */
  readonly status: TenantStatus;
  /** Commercial plan key. */
  readonly plan: string;
  /** IANA timezone used for date rendering. */
  readonly timezone: string;
  /** Locale used for message formatting. */
  readonly locale: string;
  /** Epoch milliseconds of the moment the registry row was loaded. */
  readonly resolvedAt: number;
}

/**
 * Authentication principal attached to the request after guards have run.
 */
export type Principal =
  | {
      /** Discriminates the principal kind. */
      readonly kind: 'platform-admin';
      /** Administrator primary key. */
      readonly id: string;
      /** Non-PII display name. */
      readonly displayName: string;
      /** Platform role, used for RBAC. */
      readonly role: 'OWNER' | 'ADMIN' | 'AUDITOR';
      /** Tenant the administrator explicitly targeted, if any. */
      readonly tenantId: string | null;
    }
  | {
      readonly kind: 'tenant-user';
      readonly id: string;
      readonly displayName: string;
      readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
      readonly tenantId: string;
    }
  | {
      readonly kind: 'api-key';
      readonly id: string;
      readonly name: string;
      readonly tenantId: string;
      readonly scopes: readonly string[];
    };

/**
 * Per-request state, propagated with `AsyncLocalStorage`.
 */
export interface RequestContext {
  /** Resolved tenant, absent on platform-level endpoints. */
  readonly tenant: TenantContext | null;
  /** Authenticated principal, absent until a guard runs. */
  readonly principal: Principal | null;
  /** Request correlation id, echoed in responses and the audit trail. */
  readonly requestId: string;
  /** Keyed hash of the client IP. */
  readonly ipHash: string | null;
  /** SHA-256 of the user agent. */
  readonly userAgentHash: string | null;
}

/** Empty context used as the AsyncLocalStorage seed value. */
export const EMPTY_REQUEST_CONTEXT: RequestContext = {
  tenant: null,
  principal: null,
  requestId: '',
  ipHash: null,
  userAgentHash: null,
};
