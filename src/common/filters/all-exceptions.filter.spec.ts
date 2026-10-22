import { describe, expect, it, jest } from '@jest/globals';
import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { AllExceptionsFilter, redactRequestUrl } from './all-exceptions.filter';
import {
  AppException,
  ConflictException,
  IdempotencyInProgressException,
  IdempotencyKeyReusedException,
  OrderStateConflictException,
  ProviderDeclinedException,
  ProviderOutcomeUnknownException,
} from '../errors/app.exception';
import { PiiRedactionService } from '../../pii/pii-redaction.service';
import { NetpayRequestError, NetpayTransportError } from '../../payments/netpay.client';

/**
 * Runs the filter against one exception and captures what reached the client and the log.
 *
 * @param exception Thrown value.
 * @param url Request URL as Express reports it.
 * @returns HTTP status, JSON body and every logged line.
 */
function run(exception: unknown, url = '/api/v1/t/payments/orders/x/refund') {
  const logged: string[] = [];
  const capture = (message: unknown) => {
    logged.push(String(message));
  };
  const spies = [
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture),
  ];
  let status = 0;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
      return response;
    },
    status: (code: number) => {
      status = code;
      return response;
    },
    json: (payload: Record<string, unknown>) => {
      body = payload;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url, originalUrl: url, id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter(new PiiRedactionService(true)).catch(exception, host);
  spies.forEach((spy) => spy.mockRestore());
  return { status, body, logged, headers };
}

describe('AllExceptionsFilter — stable error shape (BN-REQ-API-002)', () => {
  it('nests code, message and retryable under `error`, with requestId at the top', () => {
    const { status, body } = run(new ConflictException('Busy.'));
    expect(status).toBe(409);
    expect(body).toMatchObject({
      error: { code: 'CONFLICT', message: 'Busy.', retryable: false },
      requestId: 'req-1',
    });
  });

  it('carries details inside `error` when present', () => {
    const { body } = run(new AppException('Bad.', 'X', 400, { field: 'amount' }));
    expect(body['error']).toEqual({
      code: 'X',
      message: 'Bad.',
      retryable: false,
      details: { field: 'amount' },
    });
  });

  it('marks an unexpected 500 as not retryable and says nothing more', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body['error']).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred. The incident has been logged.',
      retryable: false,
    });
  });
});

describe('AllExceptionsFilter — provider outcomes (BN-REQ-PAY-011)', () => {
  it('answers 504 PROVIDER_OUTCOME_UNKNOWN, retryable, to a Netpay timeout', () => {
    const { status, body } = run(
      new NetpayTransportError('/v3/transactions/tx/refund', new Error('timeout')),
    );
    expect(status).toBe(504);
    expect(body['error']).toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: true });
  });

  it('answers 504 PROVIDER_OUTCOME_UNKNOWN to a Netpay 5xx: the operation may have happened', () => {
    const { status, body } = run(new NetpayRequestError(500, '/v3/transactions/tx/refund', 'boom'));
    expect(status).toBe(504);
    expect(body['error']).toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: true });
  });

  it('answers 502 PROVIDER_DECLINED, not retryable, to an explicit refusal', () => {
    const { status, body } = run(new NetpayRequestError(400, '/v3.5/charges/', 'Invalid Token'));
    expect(status).toBe(502);
    expect(body['error']).toMatchObject({ code: 'PROVIDER_DECLINED', retryable: false });
  });

  it('exposes the generic classes with the same codes', () => {
    expect(new ProviderOutcomeUnknownException('Netpay')).toMatchObject({
      code: 'PROVIDER_OUTCOME_UNKNOWN',
      status: 504,
      retryable: true,
    });
    expect(new ProviderDeclinedException('Netpay')).toMatchObject({
      code: 'PROVIDER_DECLINED',
      status: 502,
      retryable: false,
    });
  });
});

describe('AllExceptionsFilter — log redaction (BN-REQ-SEC-005)', () => {
  it('never logs the inbound webhook token on a 500', () => {
    const { logged } = run(new Error('boom'), '/api/v1/payments/webhook/abc123secrettoken');
    const text = logged.join('\n');
    expect(text).toContain('/api/v1/payments/webhook/[REDACTED]');
    expect(text).not.toContain('abc123secrettoken');
  });

  it('never logs the inbound webhook token on a 4xx', () => {
    const { logged } = run(new ConflictException('x'), '/payments/webhook/abc123secrettoken');
    expect(logged.join('\n')).not.toContain('abc123secrettoken');
  });

  it('never logs query string values', () => {
    const { logged } = run(new Error('boom'), '/api/v1/t/x?processorTransactionId=secret-value&b=2');
    const text = logged.join('\n');
    expect(text).not.toContain('secret-value');
    expect(text).toContain('processorTransactionId=[REDACTED]');
  });

  it.each([
    ['/api/v1/payments/webhook/abc', '/api/v1/payments/webhook/[REDACTED]'],
    ['/payments/webhook/abc/extra', '/payments/webhook/[REDACTED]/extra'],
    ['/payments/webhook/', '/payments/webhook/'],
    ['/a?x=1&y', '/a?x=[REDACTED]&y'],
    ['/plain', '/plain'],
  ])('redactRequestUrl(%s) is %s', (input, expected) => {
    expect(redactRequestUrl(input)).toBe(expected);
  });
});

describe('AllExceptionsFilter — idempotency and order state codes (BN-TASK-010, BN-TASK-014)', () => {
  it('answers 409 IDEMPOTENCY_IN_PROGRESS as retryable, with Retry-After', () => {
    const { status, body, headers } = run(new IdempotencyInProgressException());
    expect(status).toBe(409);
    expect(body['error']).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', retryable: true });
    expect(headers['Retry-After']).toBe('2');
  });

  it('answers 422 IDEMPOTENCY_KEY_REUSED, not retryable and without Retry-After', () => {
    const { status, body, headers } = run(new IdempotencyKeyReusedException());
    expect(status).toBe(422);
    expect(body['error']).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('answers 409 ORDER_STATE_CONFLICT with the order status in details', () => {
    const { status, body } = run(new OrderStateConflictException('Unknown.', { status: 'CHARGE_UNKNOWN' }));
    expect(status).toBe(409);
    expect(body['error']).toMatchObject({
      code: 'ORDER_STATE_CONFLICT',
      retryable: false,
      details: { status: 'CHARGE_UNKNOWN' },
    });
  });
});
