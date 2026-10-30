import 'reflect-metadata';
import { jest } from '@jest/globals';
import { TenantStatus } from '../generated/control-plane/enums';
import { TenantsService } from './tenants.service';
import { TenantSchemaNamingService } from './tenant-schema-naming.service';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantProvisionerService } from './tenant-provisioner.service';
import type { TenantResolverService } from './tenant-resolver.service';
import type { ApiKeyService } from '../api-keys/api-key.service';
import type { AuditLogService } from '../audit/audit-log.service';
import type { RequestContextService } from './request-context.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function setup(status: TenantStatus) {
  const row = {
    id: TENANT_ID,
    slug: 'aglos',
    name: 'Aglos',
    schemaName: 'tenant_aglos',
    status,
    plan: 'standard',
    timezone: 'UTC',
    locale: 'en-US',
    settings: {},
    supportContact: null,
    schemaVersion: 1,
    provisionedAt: null,
    suspendedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const create = jest.fn();
  const prisma = {
    client: { tenant: { findUnique: jest.fn(() => Promise.resolve(row)), create } },
  } as unknown as ControlPlanePrismaService;
  const provisionSchema = jest.fn(() => Promise.resolve('tenant_aglos'));
  const markActive = jest.fn(() => Promise.resolve());
  const provisioner = { provisionSchema, markActive } as unknown as TenantProvisionerService;
  const audit = { record: jest.fn(() => Promise.resolve()) } as unknown as AuditLogService;
  const requestContext = {
    get: () => ({ ipHash: null, userAgentHash: null }),
    principal: undefined,
  } as unknown as RequestContextService;
  const service = new TenantsService(
    prisma,
    provisioner,
    {} as TenantResolverService,
    new TenantSchemaNamingService(),
    {} as ApiKeyService,
    audit,
    requestContext,
  );
  return { service, provisionSchema, markActive, create };
}

describe('TenantsService.create with an existing slug', () => {
  it('retries provisioning a tenant stuck in PROVISIONING instead of answering 409', async () => {
    const { service, provisionSchema, markActive, create } = setup(TenantStatus.PROVISIONING);
    await expect(service.create({ slug: 'aglos', name: 'Aglos' })).resolves.toMatchObject({ id: TENANT_ID });
    expect(provisionSchema).toHaveBeenCalledWith('aglos');
    expect(markActive).toHaveBeenCalledWith(TENANT_ID);
    expect(create).not.toHaveBeenCalled();
  });

  it('still rejects a slug that belongs to an active tenant', async () => {
    const { service, provisionSchema } = setup(TenantStatus.ACTIVE);
    await expect(service.create({ slug: 'aglos', name: 'Aglos' })).rejects.toThrow(/already in use/);
    expect(provisionSchema).not.toHaveBeenCalled();
  });
});
