import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { MemberRole } from '../../generated/tenant-plane/enums';
import { AuthorizationException } from '../errors/app.exception';
import { RequestContextService } from '../../tenancy/request-context.service';
import { MinimumTenantRole, MINIMUM_TENANT_ROLE, TenantRoleGuard } from './tenant-role.decorator';
import type { Principal } from '../../tenancy/tenant-context.interface';

const TENANT = '11111111-1111-4111-8111-111111111111';

function guardFor(principal: Principal | null, required?: MemberRole) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) => (key === MINIMUM_TENANT_ROLE ? required : undefined));
  const context = new RequestContextService();
  const ctx = { getHandler: () => Probe, getClass: () => Probe } as unknown as ExecutionContext;
  const guard = new TenantRoleGuard(reflector, context);
  return { guard, ctx, context, principal };
}

class Probe {}

const member = (role: MemberRole): Principal => ({
  kind: 'tenant-user',
  id: `member-${role}`,
  displayName: 'M',
  role,
  tenantId: TENANT,
});

describe('TenantRoleGuard (regression: a read-only member must not reach admin routes)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses a VIEWER on an ADMIN route', () => {
    const { guard, ctx, context, principal } = guardFor(member(MemberRole.VIEWER), MemberRole.ADMIN);
    expect(() => context.run({ principal }, () => guard.canActivate(ctx))).toThrow(AuthorizationException);
  });

  it('refuses a MEMBER on an ADMIN route', () => {
    const { guard, ctx, context, principal } = guardFor(member(MemberRole.MEMBER), MemberRole.ADMIN);
    expect(() => context.run({ principal }, () => guard.canActivate(ctx))).toThrow(AuthorizationException);
  });

  it.each([MemberRole.ADMIN, MemberRole.OWNER])('admits %s on an ADMIN route', (role) => {
    const { guard, ctx, context, principal } = guardFor(member(role), MemberRole.ADMIN);
    expect(context.run({ principal }, () => guard.canActivate(ctx))).toBe(true);
  });

  it('admits every tenant role when the minimum is VIEWER', () => {
    for (const role of Object.values(MemberRole)) {
      const { guard, ctx, context, principal } = guardFor(member(role), MemberRole.VIEWER);
      expect(context.run({ principal }, () => guard.canActivate(ctx))).toBe(true);
    }
  });

  it('leaves routes without the decorator untouched', () => {
    const { guard, ctx, context, principal } = guardFor(member(MemberRole.VIEWER), undefined);
    expect(context.run({ principal }, () => guard.canActivate(ctx))).toBe(true);
  });

  it('does not judge platform administrators or API keys by tenant role', () => {
    const admin: Principal = {
      kind: 'platform-admin',
      id: 'a',
      displayName: 'A',
      role: 'AUDITOR',
      tenantId: null,
    };
    const key: Principal = { kind: 'api-key', id: 'k', name: 'n', tenantId: TENANT, scopes: [] };
    for (const p of [admin, key, null]) {
      const { guard, ctx, context } = guardFor(p, MemberRole.ADMIN);
      expect(context.run({ principal: p }, () => guard.canActivate(ctx))).toBe(true);
    }
  });

  it('exposes a decorator that writes the minimum-role metadata', () => {
    class Target {
      handler(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Target.prototype, 'handler')!;
    MinimumTenantRole(MemberRole.ADMIN)(Target.prototype, 'handler', descriptor);
    expect(Reflect.getMetadata(MINIMUM_TENANT_ROLE, descriptor.value)).toBe(MemberRole.ADMIN);
  });
});
