import 'reflect-metadata';
import { jest } from '@jest/globals';
import { AppException, AuthorizationException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import { MemberRole } from '../generated/tenant-plane/enums';
import type { Principal, TenantContext } from '../tenancy/tenant-context.interface';
import { TenantUsersService } from './tenant-users.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';

type CreatePayload = {
  role?: MemberRole;
  status?: string;
  passwordHash?: string | null;
  createdById?: string | null;
};
type CreatedRow = CreatePayload & { id: string };

/**
 * Minimal stand-in for TenantUsersService covering only `create`; every collaborator
 * is a stub, so the assertions isolate the authorization decision under test.
 */
function serviceFor(principal: Principal | null) {
  const created: CreatePayload[] = [];
  const grants: { userId: string; roleId: string; assignedById: string }[] = [];
  const lookedUp: string[] = [];

  const tenantPrisma = {
    // Every tenant read and write goes through the tenant-bound transaction now,
    // because the tables carry row-level security keyed off the same binding.
    forCurrentTenantTransaction: <T>(cb: (client: unknown) => Promise<T>): Promise<T> =>
      cb({
        userRole: {
          create: jest
            .fn<
              (args: { data: { userId: string; roleId: string; assignedById: string } }) => Promise<unknown>
            >()
            .mockImplementation((args) => {
              grants.push(args.data);
              return Promise.resolve({});
            }),
        },
        user: {
          findUnique: jest.fn<() => Promise<null>>().mockResolvedValue(null),
          create: jest
            .fn<(args: { data: CreatePayload }) => Promise<CreatedRow>>()
            .mockImplementation((args) => {
              created.push(args.data);
              return Promise.resolve({ id: 'new-member', ...args.data } as CreatedRow);
            }),
        },
      }),
  };

  const context = new RequestContextService();

  const service = new TenantUsersService(
    tenantPrisma as never,
    { hash: jest.fn<() => Promise<string>>().mockResolvedValue('argon2-hash') } as never,
    {
      verifyAccessToken: jest.fn(),
      issuePair: jest.fn(),
      issueInvitationToken: jest
        .fn()
        .mockReturnValue({ token: 'invitation-token', expiresAt: Date.now() + 60_000 }),
    } as never,
    {
      blindIndex: jest.fn().mockReturnValue('blind-index'),
      encrypt: jest.fn().mockReturnValue('ciphertext'),
    } as never,
    { record: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) } as never,
    context,
    {
      client: {
        role: {
          findUnique: jest
            .fn<(args: { where: { name: string } }) => Promise<{ id: string }>>()
            .mockImplementation((args) => {
              lookedUp.push(args.where.name);
              return Promise.resolve({ id: `role-${args.where.name}` });
            }),
        },
      },
    } as never,
  );

  return { service, context, created, grants, lookedUp, principal };
}

const tenantUser = (role: MemberRole): Principal => ({
  kind: 'tenant-user',
  id: 'viewer-caller-id',
  displayName: 'Viewer',
  role,
  tenantId: TENANT_A,
});

const apiKey: Principal = {
  kind: 'api-key',
  id: 'key-1',
  name: 'integration',
  tenantId: TENANT_A,
  scopes: ['users:write'],
};

const tenantContext = (): TenantContext => ({
  id: TENANT_A,
  slug: 'a',
  name: 'A',
  schemaName: 'tenant_a',
  status: 'ACTIVE',
  plan: 'standard',
  timezone: 'UTC',
  locale: 'en',
  resolvedAt: Date.now(),
});

const run = <T>(
  context: RequestContextService,
  principal: Principal | null,
  fn: () => Promise<T>,
): Promise<T> => context.run({ tenant: tenantContext(), principal }, fn);

const base = {
  email: 'attacker@dummy.test',
  displayName: 'Escalated',
  password: 'correct-horse-battery-staple',
};

describe('TenantUsersService.create (regression: role grant is authorized)', () => {
  it('refuses to grant OWNER from a VIEWER session', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.VIEWER));
    await expect(
      run(context, principal, () => service.create({ ...base, role: MemberRole.OWNER })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(created).toHaveLength(0);
  });

  it('refuses to grant OWNER even from an ADMIN session', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.ADMIN));
    await expect(
      run(context, principal, () => service.create({ ...base, role: MemberRole.OWNER })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(created).toHaveLength(0);
  });

  it('refuses a VIEWER granting ADMIN, which is above its own role', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.VIEWER));
    await expect(
      run(context, principal, () => service.create({ ...base, role: MemberRole.ADMIN })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(created).toHaveLength(0);
  });

  it('allows a MEMBER granting MEMBER', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.MEMBER));
    await run(context, principal, () => service.create({ ...base, role: MemberRole.MEMBER }));
    expect(created[0]?.role).toBe(MemberRole.MEMBER);
  });

  it('allows an ADMIN granting ADMIN', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.ADMIN));
    await run(context, principal, () => service.create({ ...base, role: MemberRole.ADMIN }));
    expect(created[0]?.role).toBe(MemberRole.ADMIN);
  });

  it('defaults an omitted role to MEMBER for a MEMBER caller', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.MEMBER));
    await run(context, principal, () => service.create(base));
    expect(created[0]?.role).toBe(MemberRole.MEMBER);
  });

  it('refuses a VIEWER even with no role requested, because the default MEMBER exceeds it', async () => {
    // VIEWER is documented read-only. The ceiling check is what makes the route
    // unusable for VIEWER rather than silently minting a MEMBER for them.
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.VIEWER));
    await expect(run(context, principal, () => service.create(base))).rejects.toBeInstanceOf(
      AuthorizationException,
    );
    expect(created).toHaveLength(0);
  });

  it('refuses a MEMBER granting ADMIN', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.MEMBER));
    await expect(
      run(context, principal, () => service.create({ ...base, role: MemberRole.ADMIN })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(created).toHaveLength(0);
  });

  it.each([
    [MemberRole.ADMIN, 'tenant-admin'],
    [MemberRole.MEMBER, 'tenant-member'],
  ])('grants the %s member the %s system role', async (role, roleName) => {
    const { service, context, grants, lookedUp, principal } = serviceFor(tenantUser(MemberRole.ADMIN));
    await run(context, principal, () => service.create({ ...base, role }));
    expect(lookedUp).toEqual([roleName]);
    expect(grants).toEqual([
      { userId: 'new-member', roleId: `role-${roleName}`, assignedById: 'viewer-caller-id' },
    ]);
  });

  it('grants nothing when the request is refused', async () => {
    const { service, context, grants, lookedUp, principal } = serviceFor(tenantUser(MemberRole.VIEWER));
    await expect(
      run(context, principal, () => service.create({ ...base, role: MemberRole.ADMIN })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(lookedUp).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  it('activates the row and records the caller', async () => {
    const { service, context, created, principal } = serviceFor(tenantUser(MemberRole.MEMBER));
    await run(context, principal, () => service.create(base));
    expect(created[0]?.status).toBe('ACTIVE');
    expect(created[0]?.passwordHash).toBe('argon2-hash');
    expect(created[0]?.createdById).toBe('viewer-caller-id');
  });

  it('refuses to create a member when no principal is present', async () => {
    const { service, context, created, principal } = serviceFor(null);
    await expect(run(context, principal, () => service.create(base))).rejects.toBeInstanceOf(
      AuthorizationException,
    );
    expect(created).toHaveLength(0);
  });

  it('caps an api-key principal at MEMBER: ADMIN is refused (BN-REQ-SEC-002)', async () => {
    const { service, context, created, principal } = serviceFor(apiKey);
    const { password: _password, ...invite } = base;
    void _password;
    await expect(
      run(context, principal, () => service.create({ ...invite, role: MemberRole.ADMIN })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(created).toHaveLength(0);
  });

  it('refuses a caller-supplied password from an api-key principal with 422 (BN-REQ-SEC-002)', async () => {
    const { service, context, created, principal } = serviceFor(apiKey);
    const attempt = run(context, principal, () => service.create({ ...base, role: MemberRole.MEMBER }));
    await expect(attempt).rejects.toBeInstanceOf(AppException);
    await expect(attempt).rejects.toMatchObject({ status: 422, code: 'PASSWORD_NOT_ACCEPTED' });
    expect(created).toHaveLength(0);
  });

  it('invites the member created by an api-key: INVITED, no password, one-time token returned', async () => {
    const { service, context, created, principal } = serviceFor(apiKey);
    const { password: _password, ...invite } = base;
    void _password;
    const result = await run(context, principal, () =>
      service.create({ ...invite, role: MemberRole.MEMBER }),
    );
    expect(created[0]?.role).toBe(MemberRole.MEMBER);
    expect(created[0]?.status).toBe('INVITED');
    expect(created[0]?.passwordHash).toBeNull();
    expect(created[0]?.createdById).toBe('key-1');
    expect(result.invitation?.token).toBe('invitation-token');
  });

  it('returns no invitation for a member created active with a password', async () => {
    const { service, context, principal } = serviceFor(tenantUser(MemberRole.ADMIN));
    const result = await run(context, principal, () => service.create({ ...base, role: MemberRole.MEMBER }));
    expect(result.invitation).toBeNull();
  });

  it('still refuses OWNER from an api-key principal', async () => {
    const { service, context, created, principal } = serviceFor(apiKey);
    const { password: _password, ...invite } = base;
    void _password;
    await expect(
      run(context, principal, () => service.create({ ...invite, role: MemberRole.OWNER })),
    ).rejects.toBeInstanceOf(AuthorizationException);
    expect(created).toHaveLength(0);
  });
});

describe('TenantUsersService.acceptInvitation (BN-REQ-SEC-002 invitation flow)', () => {
  type Row = { id: string; status: string; passwordHash: string | null; deletedAt: Date | null };

  function invitationService(row: Row | null, claims: { sub: string; tid: string } | Error) {
    const updates: unknown[] = [];
    const context = new RequestContextService();
    const tenantPrisma = {
      forCurrentTenantTransaction: <T>(cb: (client: unknown) => Promise<T>): Promise<T> =>
        cb({
          user: {
            findUnique: jest.fn<() => Promise<Row | null>>().mockResolvedValue(row),
            updateMany: jest
              .fn<(args: unknown) => Promise<{ count: number }>>()
              .mockImplementation((args) => {
                updates.push(args);
                return Promise.resolve({ count: row?.status === 'INVITED' ? 1 : 0 });
              }),
          },
        }),
    };
    const verifyInvitationToken = jest.fn(() => {
      if (claims instanceof Error) {
        throw claims;
      }
      return claims;
    });
    const service = new TenantUsersService(
      tenantPrisma as never,
      { hash: jest.fn<() => Promise<string>>().mockResolvedValue('argon2-hash') } as never,
      { verifyInvitationToken } as never,
      {} as never,
      { record: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) } as never,
      context,
      {} as never,
    );
    return { service, context, updates };
  }

  const invited: Row = { id: 'member-9', status: 'INVITED', passwordHash: null, deletedAt: null };

  it('activates the invited member with the chosen password', async () => {
    const { service, context, updates } = invitationService(invited, { sub: 'member-9', tid: TENANT_A });
    await context.run({ tenant: tenantContext() }, () =>
      service.acceptInvitation('tok', 'Chosen-Password-1'),
    );
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0])).toContain('"status":"ACTIVE"');
    expect(JSON.stringify(updates[0])).toContain('argon2-hash');
  });

  it('is one-time: an already active member cannot be re-activated with the same token', async () => {
    const active: Row = { ...invited, status: 'ACTIVE', passwordHash: 'existing' };
    const { service, context, updates } = invitationService(active, { sub: 'member-9', tid: TENANT_A });
    await expect(
      context.run({ tenant: tenantContext() }, () => service.acceptInvitation('tok', 'Chosen-Password-1')),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    expect(updates).toHaveLength(0);
  });

  it('refuses a token minted for another tenant', async () => {
    const { service, context } = invitationService(invited, { sub: 'member-9', tid: 'other-tenant' });
    await expect(
      context.run({ tenant: tenantContext() }, () => service.acceptInvitation('tok', 'Chosen-Password-1')),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
  });

  it('refuses a forged or expired token', async () => {
    const { service, context } = invitationService(invited, new Error('jwt expired'));
    await expect(
      context.run({ tenant: tenantContext() }, () => service.acceptInvitation('tok', 'Chosen-Password-1')),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
  });
});
