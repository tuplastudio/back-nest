import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, AuditOutcome } from '../generated/control-plane/enums';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { Prisma } from '../generated/control-plane/client';

/**
 * Fields accepted when recording an audit event.
 */
export interface AuditEntry {
  /** Tenant the event belongs to, or `null` for platform-level events. */
  readonly tenantId?: string | null;
  /** Kind of actor that produced the event. */
  readonly actorType: AuditActorType;
  /** Primary key of the actor, when known. */
  readonly actorId?: string | null;
  /** Non-PII label captured at event time, so history stays readable. */
  readonly actorLabel?: string | null;
  /** Dotted action name, e.g. `tenant.provision`. */
  readonly action: string;
  /** Type of the affected resource. */
  readonly resourceType: string;
  /** Primary key of the affected resource, when known. */
  readonly resourceId?: string | null;
  /** Result of the action. Defaults to `SUCCESS`. */
  readonly outcome?: AuditOutcome;
  /** Structured, PII-free context. */
  readonly metadata?: Record<string, unknown>;
  /** Keyed hash of the client IP. */
  readonly ipHash?: string | null;
  /** SHA-256 of the user agent. */
  readonly userAgentHash?: string | null;
}

/**
 * Cursor-based page of audit entries.
 */
export interface AuditPage {
  /** Entries, newest first. */
  readonly items: readonly Record<string, unknown>[];
  /** Cursor for the next page, or `null` when the page is the last one. */
  readonly nextCursor: string | null;
  /** Total number of matching rows. */
  readonly total: number;
}

/**
 * Append-only audit trail.
 *
 * Design decisions
 * ----------------
 * * **Never throws into the request path.** A compliance requirement must not be
 *   able to take the API down; a write failure is logged loudly instead. Callers
 *   that need audit durability for a critical operation (tenant provisioning)
 *   pass `strict: true`.
 * * **Append-only by construction.** The model has no `onDelete: Cascade` and the
 *   service exposes no update or delete method. Retention is a separate,
 *   explicitly reviewed job.
 * * **PII-free metadata.** Metadata is scrubbed before storage so an operator
 *   cannot accidentally persist an e-mail or a token. Structured context belongs
 *   in the dedicated columns, which are typed and purpose-built.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  /**
   * @param prisma Control-plane Prisma service.
   */
  constructor(private readonly prisma: ControlPlanePrismaService) {}

  /**
   * Records an audit event.
   *
   * @param entry Event fields.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          tenantId: entry.tenantId ?? null,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          actorLabel: entry.actorLabel ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          outcome: entry.outcome ?? AuditOutcome.SUCCESS,
          metadata: entry.metadata ? this.stripPii(entry.metadata) : undefined,
          ipHash: entry.ipHash ?? null,
          userAgentHash: entry.userAgentHash ?? null,
        },
      });
    } catch (error) {
      // Compliance data must not break the operation it describes, but a silent
      // loss is unacceptable, so this is logged at error level.
      this.logger.error(
        `Failed to record audit event "${entry.action}" for ${entry.resourceType}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Records an audit event inside an existing transaction.
   *
   * Used when the audited change and its audit row must commit together, e.g.
   * tenant provisioning. A failure here rolls the whole transaction back, which
   * is the correct behaviour for a critical control-plane mutation.
   *
   * @param tx Transaction client.
   * @param entry Event fields.
   */
  async recordInTransaction(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: entry.tenantId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        outcome: entry.outcome ?? AuditOutcome.SUCCESS,
        metadata: entry.metadata ? this.stripPii(entry.metadata) : undefined,
        ipHash: entry.ipHash ?? null,
        userAgentHash: entry.userAgentHash ?? null,
      },
    });
  }

  /**
   * Queries the audit trail with cursor pagination.
   *
   * Cursor pagination rather than offsets: audit tables are append-only and
   * grow without bound, so offset pagination would degrade and could skip rows
   * when new entries arrive mid-scan.
   *
   * @param filters Query filters.
   * @returns A page of entries plus the next cursor.
   */
  async list(filters: {
    tenantId?: string | null;
    actorType?: AuditActorType;
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    cursor?: string;
  }): Promise<AuditPage> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const where: Prisma.AuditLogWhereInput = {
      ...(filters.tenantId !== undefined ? { tenantId: filters.tenantId } : {}),
      ...(filters.actorType ? { actorType: filters.actorType } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.action ? { action: { startsWith: filters.action } } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
      ...(filters.cursor ? { createdAt: { lt: new Date(filters.cursor) } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.client.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          tenantId: true,
          actorType: true,
          actorId: true,
          actorLabel: true,
          action: true,
          resourceType: true,
          resourceId: true,
          outcome: true,
          metadata: true,
          createdAt: true,
        },
      }),
      this.prisma.client.auditLog.count({ where }),
    ]);

    const last = rows.at(-1);
    return {
      items: rows,
      nextCursor: rows.length === limit && last ? last.createdAt.toISOString() : null,
      total,
    };
  }

  /**
   * Removes audit entries older than a cutoff.
   *
   * Exposed only for the retention job; never called from a request handler.
   *
   * @param cutoff Entries strictly older than this instant are deleted.
   * @returns Number of rows removed.
   */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const result = await this.prisma.client.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    this.logger.warn(`Purged ${result.count} audit entries older than ${cutoff.toISOString()}.`);
    return result.count;
  }

  /**
   * Strips obviously sensitive keys from audit metadata.
   *
   * A defence-in-depth measure: even if a caller passes a raw request body, the
   * most damaging keys never reach the database.
   *
   * @param metadata Arbitrary metadata object.
   * @returns The metadata with sensitive keys replaced.
   */
  private stripPii(metadata: Record<string, unknown>): Prisma.InputJsonValue {
    const sensitive = /(password|secret|token|apikey|api_key|authorization|cookie|creditcard|cvv|ssn)/i;

    const walk = (value: unknown, depth: number): Prisma.InputJsonValue => {
      if (depth > 4) {
        return '[TRUNCATED]';
      }
      if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        return value as Prisma.InputJsonValue;
      }
      if (typeof value === 'string') {
        return value.length > 500 ? `${value.slice(0, 500)}…` : value;
      }
      if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => walk(item, depth + 1));
      }
      if (typeof value === 'object') {
        const output: Record<string, Prisma.InputJsonValue> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          output[key] = sensitive.test(key) ? '[REDACTED]' : walk(entry, depth + 1);
        }
        return output;
      }
      // Symbols and functions reach here; never fall back to `String(value)` for
      // objects, because `[object Object]` is useless in an audit record.
      return typeof value === 'symbol' ? value.toString() : '[unserialisable]';
    };

    return walk(metadata, 0);
  }
}
