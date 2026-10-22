import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, of, throwError, type Observable } from 'rxjs';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import {
  AppException,
  IdempotencyInProgressException,
  IdempotencyKeyReusedException,
  ValidationException,
  isRetryableStatus,
} from '../errors/app.exception';
import { IdempotencyStore, type StoredResponse } from './idempotency.store';

/** Request header naming one logical request. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Response header set when the answer is a stored one. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** Accepted keys: 1-255 printable ASCII characters (a UUID is the usual choice). */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Seconds a client is told to wait while the first request runs. */
const RETRY_AFTER_SECONDS = 2;

/**
 * Serialises a value with sorted object keys, so two bodies that differ only in
 * key order hash the same.
 *
 * @param value Parsed JSON body.
 * @returns Canonical JSON.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of the canonical body.
 *
 * @param body Parsed JSON body.
 * @returns Lower-case hex digest.
 */
export function requestHashOf(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/**
 * Applies `Idempotency-Key` to a money-moving route (BN-REQ-IDM-001/002/003).
 *
 * Without the header the route behaves as before. With it:
 *
 *  * the first request inserts the key as IN_PROGRESS and runs;
 *  * a repeat with the same body gets the stored response, and the handler (so
 *    Netpay) is not called; it carries `Idempotency-Replayed: true`;
 *  * a repeat with another body is refused, 422 `IDEMPOTENCY_KEY_REUSED`;
 *  * a repeat while the first runs is refused, 409 `IDEMPOTENCY_IN_PROGRESS`
 *    with `Retry-After: 2`.
 *
 * A success and a definitive 4xx are stored as DONE for 24 h. A 5xx or 504 is
 * not: the operation may have happened at the provider, so the key stays
 * IN_PROGRESS for 10 min, long enough for reconciliation to settle the order,
 * and a repeat inside that window is refused rather than run twice. A retryable
 * 4xx (408, 429) changed nothing and frees the key.
 *
 * Runs after the guards, so the tenant is resolved and the key is scoped to it;
 * the route includes the concrete path, so a key is also scoped to one order.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly store: IdempotencyStore,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const raw = request.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (key === undefined) {
      return next.handle();
    }
    if (!KEY_PATTERN.test(key)) {
      throw new ValidationException('Idempotency-Key must be 1 to 255 printable ASCII characters.');
    }
    const schemaName = this.tenantPrisma.requireCurrentSchema();
    const route = `${request.method} ${(request.originalUrl ?? request.url).split('?')[0]}`.slice(0, 255);
    const begun = await this.store.begin(schemaName, key, route, requestHashOf(request.body));

    switch (begun.kind) {
      case 'reused':
        throw new IdempotencyKeyReusedException();
      case 'in_progress':
        throw new IdempotencyInProgressException(RETRY_AFTER_SECONDS);
      case 'replay':
        http.getResponse<Response>().setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
        return this.replay(begun.status, begun.response);
      case 'owner':
        break;
    }

    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (request.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);
    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        await this.safely(() =>
          this.store.complete(schemaName, key, route, successStatus, { kind: 'success', body: body ?? null }),
        );
        return body;
      }),
      catchError((error: unknown) =>
        from(this.recordFailure(schemaName, key, route, error)).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  /**
   * Answers with a stored response.
   *
   * @param status Status stored with it.
   * @param response What was stored.
   * @returns The body, or an error the exception filter renders as before.
   */
  private replay(status: number, response: StoredResponse): Observable<unknown> {
    switch (response.kind) {
      case 'success':
        return of(response.body);
      case 'app-error':
        return throwError(
          () =>
            new AppException(response.message, response.code, status, response.details, response.retryable),
        );
      case 'http-error':
        return throwError(() => new HttpException(response.response as Record<string, unknown>, status));
    }
  }

  /**
   * Records how a request with a key failed.
   *
   * @param schemaName Tenant schema.
   * @param key Key.
   * @param route Route.
   * @param error What the handler threw.
   */
  private async recordFailure(schemaName: string, key: string, route: string, error: unknown): Promise<void> {
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let retryable = false;
    let stored: StoredResponse | null = null;
    if (error instanceof AppException) {
      status = error.status;
      retryable = error.retryable;
      stored = {
        kind: 'app-error',
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      retryable = isRetryableStatus(status);
      stored = { kind: 'http-error', response: error.getResponse() };
    }
    if (status >= Number(HttpStatus.INTERNAL_SERVER_ERROR) || stored === null) {
      // The outcome may be unknown (504) or the server failed half-way: never run twice.
      await this.safely(() => this.store.holdInProgress(schemaName, key, route, status));
      return;
    }
    if (retryable) {
      await this.safely(() => this.store.release(schemaName, key, route));
      return;
    }
    const response = stored;
    await this.safely(() => this.store.complete(schemaName, key, route, status, response));
  }

  /**
   * Runs a bookkeeping write without letting it change the response: the
   * operation already finished, and a failed write leaves the row IN_PROGRESS,
   * which refuses repeats until it expires. That is the safe side.
   *
   * @param write The write.
   */
  private async safely(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch {
      this.logger.error('Could not record the outcome of an idempotent request; the key stays in progress.');
    }
  }
}
