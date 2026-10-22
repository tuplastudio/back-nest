import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { AuthThrottle, buildThrottlerOptions, isHealthRequest } from './throttling';
import { INTERNAL_ROUTE_KEY } from '../common/decorators/internal-route.decorator';
import type { ThrottlerStorage } from '@nestjs/throttler';

/**
 * Builds an execution context for a handler on a probe controller.
 *
 * @param handler Route handler.
 * @param controller Controller class.
 * @param url Request URL.
 * @returns A minimal HTTP execution context.
 */
function contextFor(handler: object, controller: object, url: string): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ url, originalUrl: url }) }),
  } as unknown as ExecutionContext;
}

class AuthProbe {
  signIn(this: void): void {}
  other(this: void): void {}
}
(AuthThrottle() as MethodDecorator)(AuthProbe.prototype, 'signIn', {
  value: AuthProbe.prototype.signIn,
} as PropertyDescriptor);

const config = { defaultLimit: 300, defaultTtlMs: 60_000, authLimit: 10, authTtlMs: 60_000 };

function throttler(name: string) {
  const options = buildThrottlerOptions(config);
  const found = options.throttlers.find((t) => t.name === name);
  if (!found) {
    throw new Error(`no throttler ${name}`);
  }
  return found;
}

describe('throttler configuration (BN-REQ-SEC-004)', () => {
  it('declares a default and an auth throttler with the configured budgets', () => {
    expect(throttler('default')).toMatchObject({ limit: 300, ttl: 60_000 });
    expect(throttler('auth')).toMatchObject({ limit: 10, ttl: 60_000 });
  });

  it('applies the auth throttler only to routes marked @AuthThrottle (sign-in / refresh)', () => {
    const skip = throttler('auth').skipIf!;
    expect(skip(contextFor(AuthProbe.prototype.signIn, AuthProbe, '/api/v1/auth/sign-in'))).toBe(false);
    expect(skip(contextFor(AuthProbe.prototype.other, AuthProbe, '/api/v1/t/projects'))).toBe(true);
  });

  it('exempts health routes from every throttler', () => {
    for (const name of ['default', 'auth']) {
      const skip = throttler(name).skipIf!;
      expect(skip(contextFor(AuthProbe.prototype.other, AuthProbe, '/health/ready'))).toBe(true);
      expect(skip(contextFor(AuthProbe.prototype.signIn, AuthProbe, '/health'))).toBe(true);
    }
    expect(throttler('default').skipIf!(contextFor(AuthProbe.prototype.other, AuthProbe, '/api/v1/x'))).toBe(
      false,
    );
  });

  it('exempts internal routes (POST /internal/tick) from every throttler (BN-TASK-016)', () => {
    class InternalProbe {
      tick(this: void): void {}
    }
    Reflect.defineMetadata(INTERNAL_ROUTE_KEY, true, InternalProbe.prototype.tick);
    for (const name of ['default', 'auth']) {
      expect(
        throttler(name).skipIf!(contextFor(InternalProbe.prototype.tick, InternalProbe, '/internal/tick')),
      ).toBe(true);
    }
  });

  it('recognises health paths precisely', () => {
    expect(isHealthRequest('/health')).toBe(true);
    expect(isHealthRequest('/health/live?x=1')).toBe(true);
    expect(isHealthRequest('/healthcheck')).toBe(false);
    expect(isHealthRequest('/api/v1/health')).toBe(false);
  });

  it('uses the shared storage when one is supplied, in-memory otherwise', () => {
    const storage = { increment: () => Promise.reject(new Error('unused')) } as ThrottlerStorage;
    expect(buildThrottlerOptions({ ...config, storage }).storage).toBe(storage);
    expect(buildThrottlerOptions(config).storage).toBeUndefined();
  });
});
