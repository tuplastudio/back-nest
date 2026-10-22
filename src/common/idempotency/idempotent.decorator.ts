import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { ApiConflictResponse, ApiHeader, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * Makes a route accept an optional `Idempotency-Key` (BN-REQ-IDM-001/002/003)
 * and documents it in the OpenAPI contract.
 *
 * @returns The combined decorator.
 */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'Optional; 1-255 printable ASCII characters, a UUID is recommended. A repeat with the same key and body ' +
        'within 24 h gets the stored response (header Idempotency-Replayed: true) without calling Netpay. ' +
        'After a 5xx/504 the key stays in progress for 10 min. See docs/ERRORS.md.',
      schema: { type: 'string', maxLength: 255 },
    }),
    ApiConflictResponse({
      description:
        'IDEMPOTENCY_IN_PROGRESS (with Retry-After) while the first request with this key runs; ' +
        'CONFLICT / ORDER_STATE_CONFLICT when the order does not allow the operation.',
    }),
    ApiUnprocessableEntityResponse({
      description: 'IDEMPOTENCY_KEY_REUSED: the key was already used with a different body.',
    }),
  );
