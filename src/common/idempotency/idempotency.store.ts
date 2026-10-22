import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-plane/client';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';

/** How long a DONE response answers repeats of its key (BN-REQ-IDM-001). */
export const IDEMPOTENCY_DONE_TTL_MS = 24 * 60 * 60_000;

/**
 * How long an IN_PROGRESS row holds its key: while the request runs, and after a
 * 5xx/504 whose outcome is unknown, so reconciliation settles the order before
 * the key can run the operation again. Also what frees a key whose instance died.
 */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 10 * 60_000;

/** What the stored response replays. */
export type StoredResponse =
  | { readonly kind: 'success'; readonly body: unknown }
  | {
      readonly kind: 'app-error';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly details?: Record<string, unknown>;
    }
  | { readonly kind: 'http-error'; readonly response: unknown };

/** Outcome of claiming a key. */
export type IdempotencyBegin =
  /** This request inserted the key and runs the operation. */
  | { readonly kind: 'owner' }
  /** Same key, same body, finished: answer with the stored response. */
  | { readonly kind: 'replay'; readonly status: number; readonly response: StoredResponse }
  /** Same key, different body. */
  | { readonly kind: 'reused' }
  /** Same key, same body, still running (or its outcome is unknown). */
  | { readonly kind: 'in_progress' };

/**
 * The `idempotency_record` table of a tenant schema.
 *
 * Every decision is taken by the database, so it holds across instances: the
 * first request inserts its row with `INSERT … ON CONFLICT DO NOTHING`, and only
 * the one whose insert landed calls the provider.
 */
@Injectable()
export class IdempotencyStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Claims a key for one request, or reports what an earlier request left.
   *
   * An expired row is removed first, so a key can be reused once its window
   * passed.
   *
   * @param schemaName Tenant schema.
   * @param key `Idempotency-Key` as sent.
   * @param route Method and concrete path.
   * @param requestHash SHA-256 of the canonical body.
   * @param now Current time.
   * @returns Who runs the request, or what to answer instead.
   */
  async begin(
    schemaName: string,
    key: string,
    route: string,
    requestHash: string,
    now: Date = new Date(),
  ): Promise<IdempotencyBegin> {
    return this.tenantPrisma.forTenantTransaction(schemaName, async (client) => {
      await client.idempotencyRecord.deleteMany({ where: { key, route, expiresAt: { lt: now } } });
      const inserted = await client.idempotencyRecord.createMany({
        data: [
          {
            key,
            route,
            requestHash,
            status: 'IN_PROGRESS',
            createdAt: now,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_IN_PROGRESS_TTL_MS),
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        return { kind: 'owner' } as const;
      }
      const existing = await client.idempotencyRecord.findUnique({ where: { key_route: { key, route } } });
      if (existing === null) {
        // Removed between the insert and the read: the other request is still deciding.
        return { kind: 'in_progress' } as const;
      }
      if (existing.requestHash !== requestHash) {
        return { kind: 'reused' } as const;
      }
      if (existing.status === 'DONE' && existing.responseStatus !== null && existing.responseBody !== null) {
        return {
          kind: 'replay',
          status: existing.responseStatus,
          response: existing.responseBody as unknown as StoredResponse,
        } as const;
      }
      return { kind: 'in_progress' } as const;
    });
  }

  /**
   * Stores the definitive response of a key: success, or a definitive 4xx.
   *
   * @param schemaName Tenant schema.
   * @param key Key.
   * @param route Route.
   * @param status HTTP status sent.
   * @param response What to replay.
   * @param now Current time.
   */
  async complete(
    schemaName: string,
    key: string,
    route: string,
    status: number,
    response: StoredResponse,
    now: Date = new Date(),
  ): Promise<void> {
    await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.idempotencyRecord.updateMany({
        where: { key, route },
        data: {
          status: 'DONE',
          responseStatus: status,
          // Round-tripped through JSON: what is replayed is exactly what was serialised.
          responseBody: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_DONE_TTL_MS),
        },
      }),
    );
  }

  /**
   * Leaves a key IN_PROGRESS after a 5xx/504: the outcome may be unknown, so the
   * key keeps refusing for {@link IDEMPOTENCY_IN_PROGRESS_TTL_MS} while
   * reconciliation settles the order.
   *
   * @param schemaName Tenant schema.
   * @param key Key.
   * @param route Route.
   * @param status HTTP status sent, kept for diagnosis.
   * @param now Current time.
   */
  async holdInProgress(
    schemaName: string,
    key: string,
    route: string,
    status: number,
    now: Date = new Date(),
  ): Promise<void> {
    await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.idempotencyRecord.updateMany({
        where: { key, route, status: 'IN_PROGRESS' },
        data: {
          responseStatus: status,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_IN_PROGRESS_TTL_MS),
        },
      }),
    );
  }

  /**
   * Frees a key whose request changed nothing and may simply be repeated
   * (a retryable 4xx such as 429).
   *
   * @param schemaName Tenant schema.
   * @param key Key.
   * @param route Route.
   */
  async release(schemaName: string, key: string, route: string): Promise<void> {
    await this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.idempotencyRecord.deleteMany({ where: { key, route, status: 'IN_PROGRESS' } }),
    );
  }
}
