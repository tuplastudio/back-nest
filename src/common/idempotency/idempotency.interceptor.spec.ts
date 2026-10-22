import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, HttpCode, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { canonicalJson, IdempotencyInterceptor, requestHashOf } from './idempotency.interceptor';
import type { IdempotencyBegin, IdempotencyStore, StoredResponse } from './idempotency.store';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import {
  ConflictException,
  ProviderOutcomeUnknownException,
  TooManyRequestsException,
} from '../errors/app.exception';

class Handlers {
  @HttpCode(200)
  refund(): void {}

  create(): void {}
}

/** Builds the interceptor over a fake store and one request. */
function setup(begin: IdempotencyBegin, headers: Record<string, string> = { 'idempotency-key': 'k-1' }) {
  const calls: { op: string; args: unknown[] }[] = [];
  const store = {
    begin: jest.fn((...args: unknown[]) => {
      calls.push({ op: 'begin', args });
      return Promise.resolve(begin);
    }),
    complete: jest.fn((...args: unknown[]) => {
      calls.push({ op: 'complete', args });
      return Promise.resolve();
    }),
    holdInProgress: jest.fn((...args: unknown[]) => {
      calls.push({ op: 'hold', args });
      return Promise.resolve();
    }),
    release: jest.fn((...args: unknown[]) => {
      calls.push({ op: 'release', args });
      return Promise.resolve();
    }),
  } as unknown as IdempotencyStore;
  const tenantPrisma = { requireCurrentSchema: () => 'tenant_acme' } as unknown as TenantPrismaService;
  const responseHeaders: Record<string, string> = {};
  const request = {
    method: 'POST',
    originalUrl: '/api/v1/t/payments/orders/o-1/refund?x=1',
    headers,
    body: { motive: 'm', amount: '10.00' },
  };
  const context = (handler: keyof Handlers = 'refund') =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            responseHeaders[name] = value;
          },
        }),
      }),
      // Nest hands the handler over unbound too; only its metadata is read.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => Handlers.prototype[handler],
    }) as unknown as ExecutionContext;
  const interceptor = new IdempotencyInterceptor(store, tenantPrisma, new Reflector());
  return { interceptor, calls, context, responseHeaders };
}

const answering = (value: unknown): CallHandler & { called: () => number } => {
  let count = 0;
  return {
    handle: () => {
      count += 1;
      return of(value);
    },
    called: () => count,
  };
};

const failing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

describe('IdempotencyInterceptor (BN-TASK-010)', () => {
  it('leaves a request without the header alone', async () => {
    const { interceptor, calls, context } = setup({ kind: 'owner' }, {});
    const next = answering({ ok: true });
    await expect(lastValueFrom(await interceptor.intercept(context(), next))).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('refuses a key that is not 1-255 printable characters', async () => {
    const { interceptor, context } = setup({ kind: 'owner' }, { 'idempotency-key': 'has space' });
    await expect(interceptor.intercept(context(), answering(null))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('scopes the key to the method and concrete path, and hashes the canonical body', async () => {
    const { interceptor, calls, context } = setup({ kind: 'owner' });
    await lastValueFrom(await interceptor.intercept(context(), answering({ ok: true })));
    expect(calls[0].args.slice(0, 4)).toEqual([
      'tenant_acme',
      'k-1',
      'POST /api/v1/t/payments/orders/o-1/refund',
      requestHashOf({ amount: '10.00', motive: 'm' }),
    ]);
  });

  it('stores a success with the status the route answers', async () => {
    const { interceptor, calls, context } = setup({ kind: 'owner' });
    await lastValueFrom(await interceptor.intercept(context(), answering({ status: 'REFUNDED' })));
    expect(calls[1]).toEqual({
      op: 'complete',
      args: [
        'tenant_acme',
        'k-1',
        expect.any(String),
        200,
        { kind: 'success', body: { status: 'REFUNDED' } },
      ],
    });
    const created = setup({ kind: 'owner' });
    await lastValueFrom(
      await created.interceptor.intercept(created.context('create'), answering({ id: 'o' })),
    );
    expect(created.calls[1].args[3]).toBe(201);
  });

  it('replays a stored response without calling the handler', async () => {
    const response: StoredResponse = { kind: 'success', body: { status: 'REFUNDED' } };
    const { interceptor, context, responseHeaders } = setup({ kind: 'replay', status: 200, response });
    const next = answering({ status: 'SHOULD NOT RUN' });
    await expect(lastValueFrom(await interceptor.intercept(context(), next))).resolves.toEqual({
      status: 'REFUNDED',
    });
    expect(next.called()).toBe(0);
    expect(responseHeaders['Idempotency-Replayed']).toBe('true');
  });

  it('replays a stored error as the same error', async () => {
    const response: StoredResponse = {
      kind: 'app-error',
      code: 'CONFLICT',
      message: 'Busy.',
      retryable: false,
    };
    const { interceptor, context } = setup({ kind: 'replay', status: 409, response });
    await expect(
      lastValueFrom(await interceptor.intercept(context(), answering(null))),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'Busy.',
    });
  });

  it('answers 422 to another body and 409 with Retry-After while the first runs', async () => {
    const reused = setup({ kind: 'reused' });
    await expect(reused.interceptor.intercept(reused.context(), answering(null))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 422,
    });
    const busy = setup({ kind: 'in_progress' });
    await expect(busy.interceptor.intercept(busy.context(), answering(null))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      status: 409,
      retryable: true,
      retryAfterSeconds: 2,
    });
  });

  it('stores a definitive 4xx, keeps a 5xx in progress and frees the key on a retryable 4xx', async () => {
    const conflict = setup({ kind: 'owner' });
    await expect(
      lastValueFrom(
        await conflict.interceptor.intercept(conflict.context(), failing(new ConflictException('Busy.'))),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(conflict.calls[1]).toMatchObject({
      op: 'complete',
      args: ['tenant_acme', 'k-1', expect.any(String), 409, { kind: 'app-error', code: 'CONFLICT' }],
    });

    const validation = setup({ kind: 'owner' });
    await expect(
      lastValueFrom(
        await validation.interceptor.intercept(
          validation.context(),
          failing(new BadRequestException(['bad'])),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(validation.calls[1].op).toBe('complete');
    expect(validation.calls[1].args[3]).toBe(400);

    const unknown = setup({ kind: 'owner' });
    await expect(
      lastValueFrom(
        await unknown.interceptor.intercept(
          unknown.context(),
          failing(new ProviderOutcomeUnknownException('Netpay')),
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(unknown.calls[1]).toMatchObject({
      op: 'hold',
      args: [expect.anything(), 'k-1', expect.anything(), 504],
    });

    const crash = setup({ kind: 'owner' });
    await expect(
      lastValueFrom(await crash.interceptor.intercept(crash.context(), failing(new Error('boom')))),
    ).rejects.toThrow('boom');
    expect(crash.calls[1]).toMatchObject({
      op: 'hold',
      args: [expect.anything(), 'k-1', expect.anything(), 500],
    });

    const throttled = setup({ kind: 'owner' });
    await expect(
      lastValueFrom(
        await throttled.interceptor.intercept(throttled.context(), failing(new TooManyRequestsException())),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(throttled.calls[1]).toMatchObject({ op: 'release' });
  });

  it('hashes bodies that differ only in key order the same, and other bodies differently', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(requestHashOf({ a: 1, b: 2 })).toBe(requestHashOf({ b: 2, a: 1 }));
    expect(requestHashOf({ a: 1 })).not.toBe(requestHashOf({ a: 2 }));
    expect(requestHashOf(undefined)).toBe(requestHashOf(null));
  });
});
