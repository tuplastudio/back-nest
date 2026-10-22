import 'reflect-metadata';
import { jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { AppException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { ApiKeyService } from '../api-keys/api-key.service';
import type { TokenService } from './token.service';
import type { AppConfig } from '../config/app-config.service';

/**
 * The admin session policy (MFA pending, forced password change) guards the
 * protected surface. A `@Public()` route, such as `/health/ready`, has no
 * protected surface: the policy must not turn a valid-but-restricted admin
 * session into a 403 there. The session is treated as anonymous instead, so a
 * restricted session also gains nothing on that route.
 */
function harness(options: { isPublic: boolean; mustChangePassword: boolean; mfaEnrolled: boolean }) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) => (key === IS_PUBLIC_KEY ? options.isPublic : undefined));
  const tokens = {
    verifyAccessToken: jest.fn().mockReturnValue({ sub: 'admin-1', kind: 'platform-admin' }),
  } as unknown as TokenService;
  const controlPlane = {
    client: {
      platformAdmin: {
        findUnique: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          id: 'admin-1',
          displayName: 'Root',
          role: 'OWNER',
          status: 'ACTIVE',
          mustChangePassword: options.mustChangePassword,
          mfaEnabledAt: options.mfaEnrolled ? new Date() : null,
        }),
      },
    },
  } as unknown as ControlPlanePrismaService;
  const config = { mfaRequiredForAdmins: true } as unknown as AppConfig;
  const context = new RequestContextService();
  const guard = new AuthGuard(
    reflector,
    context,
    controlPlane,
    {} as TenantPrismaService,
    {} as ApiKeyService,
    tokens,
    config,
  );
  class Probe {
    handler(): void {}
  }
  const request: AuthenticatedRequest & { headers: Record<string, string>; method: string } = {
    headers: { authorization: 'Bearer jwt-token' },
    method: 'GET',
  };
  const ctx = {
    getHandler: () => Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!.value as () => void,
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, ctx, context, request };
}

describe('AuthGuard on @Public routes with a restricted admin session', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['MFA pending (not enrolled)', { mustChangePassword: false, mfaEnrolled: false }],
    ['MFA pending (enrolled, not verified)', { mustChangePassword: false, mfaEnrolled: true }],
    ['password change pending', { mustChangePassword: true, mfaEnrolled: true }],
  ])('lets %s through a public route as an anonymous caller', async (_label, facts) => {
    const { guard, ctx, context, request } = harness({ isPublic: true, ...facts });
    const allowed = await context.run({}, async () => {
      const result = await guard.canActivate(ctx);
      // The restricted session is not attached: the public route sees no principal.
      expect(context.principal).toBeNull();
      return result;
    });
    expect(allowed).toBe(true);
    expect(request.principal).toBeUndefined();
  });

  it('still refuses the same session on a protected route', async () => {
    const { guard, ctx, context } = harness({
      isPublic: false,
      mustChangePassword: false,
      mfaEnrolled: false,
    });
    await expect(context.run({}, () => guard.canActivate(ctx))).rejects.toBeInstanceOf(AppException);
  });
});
