import 'reflect-metadata';
import { jest } from '@jest/globals';
import { ProjectsService } from './projects.service';
import { AuthorizationException, NotFoundException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import { MemberRole } from '../generated/tenant-plane/enums';
import type { Principal } from '../tenancy/tenant-context.interface';

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Written {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

function serviceFor(principal: Principal | null, project: Record<string, unknown> | null) {
  const writes: Written[] = [];
  const client = {
    project: {
      findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue(project),
      findMany: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      count: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      create: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
      update: jest.fn<(args: Written) => Promise<unknown>>((args) => {
        writes.push(args);
        return Promise.resolve({});
      }),
    },
  };
  const tenantPrisma = { forCurrentTenantTransaction: <T>(cb: (c: unknown) => Promise<T>) => cb(client) };
  const context = new RequestContextService();
  const service = new ProjectsService(tenantPrisma as never, context);
  const run = <T>(fn: () => Promise<T>) => context.run({ principal }, fn);
  return { service, writes, run };
}

const member = (id: string, role: MemberRole): Principal => ({
  kind: 'tenant-user',
  id,
  displayName: 'M',
  role,
  tenantId: '11111111-1111-4111-8111-111111111111',
});
const project = { id: 'p1', ownerId: OWNER_ID, version: 1, deletedAt: null };

describe('ProjectsService ownership (regression: a non-owner must not mutate)', () => {
  it("refuses a VIEWER updating another member's project", async () => {
    const { service, run, writes } = serviceFor(member(OTHER_ID, MemberRole.VIEWER), project);
    await expect(run(() => service.update('p1', { name: 'stolen' }))).rejects.toBeInstanceOf(
      AuthorizationException,
    );
    expect(writes).toHaveLength(0);
  });

  it("refuses a MEMBER deleting another member's project", async () => {
    const { service, run, writes } = serviceFor(member(OTHER_ID, MemberRole.MEMBER), project);
    await expect(run(() => service.remove('p1'))).rejects.toBeInstanceOf(AuthorizationException);
    expect(writes).toHaveLength(0);
  });

  it("still lets an ADMIN change anyone's project", async () => {
    const { service, run, writes } = serviceFor(member(OTHER_ID, MemberRole.ADMIN), project);
    await run(() => service.update('p1', { name: 'admin edit' }));
    expect(writes).toHaveLength(1);
  });

  it('lets the owner change their own project', async () => {
    const { service, run, writes } = serviceFor(member(OWNER_ID, MemberRole.VIEWER), project);
    await run(() => service.update('p1', { name: 'mine' }));
    expect(writes).toHaveLength(1);
  });

  it('lets an API key act on tenant projects', async () => {
    const key: Principal = { kind: 'api-key', id: 'k', name: 'n', tenantId: '1', scopes: [] };
    const { service, run, writes } = serviceFor(key, project);
    await run(() => service.remove('p1'));
    expect(writes).toHaveLength(1);
  });

  it('still returns 404 for a project that does not exist', async () => {
    const { service, run } = serviceFor(member(OWNER_ID, MemberRole.VIEWER), null);
    await expect(run(() => service.remove('missing'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('checks authorization before reporting a version conflict', async () => {
    // Otherwise a stale version would leak the current version to a caller who
    // is not allowed to touch the row at all.
    const { service, run } = serviceFor(member(OTHER_ID, MemberRole.VIEWER), { ...project, version: 7 });
    await expect(run(() => service.update('p1', { expectedVersion: 1 }))).rejects.toBeInstanceOf(
      AuthorizationException,
    );
  });
});
