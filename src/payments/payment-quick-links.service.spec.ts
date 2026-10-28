import { jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { PaymentQuickLinksService } from './payment-quick-links.service';
import { resetPaymentUrlsForTesting, setPaymentUrls } from '../config/payment-urls';
import type { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';

const link = {
  code: 'K7P3QX',
  tenantId: 't1',
  schemaName: 'tenant_acme',
  orderId: 'o1',
  hostedCheckoutUrl: 'https://netpay.test/checkout/abc',
};
const order = {
  merchantReferenceCode: 'Pastel',
  amount: { toFixed: () => '450.00' },
  currency: 'MXN',
  status: 'PENDING',
  createdAt: new Date('2026-10-27T10:00:00Z'),
  updatedAt: new Date('2026-10-27T10:05:00Z'),
};

function build(overrides: { link?: unknown; tenant?: unknown; order?: unknown } = {}) {
  const findUnique = jest.fn(() => Promise.resolve('link' in overrides ? overrides.link : link));
  const tenantFind = jest.fn(() =>
    Promise.resolve(
      'tenant' in overrides ? overrides.tenant : { name: 'ACME Corporation', status: 'ACTIVE' },
    ),
  );
  const create = jest.fn(() => Promise.resolve(link));
  const findMany = jest.fn(() => Promise.resolve([{ code: 'Q2K7P3', orderId: 'order-1' }]));
  const controlPlane = {
    client: { paymentQuickLink: { findUnique, create, findMany }, tenant: { findUnique: tenantFind } },
  } as unknown as ControlPlanePrismaService;
  const tenantPrisma = {
    forTenantTransaction: jest.fn((_schema: string, cb: (client: unknown) => Promise<unknown>) =>
      cb({
        paymentOrder: { findFirst: () => Promise.resolve('order' in overrides ? overrides.order : order) },
      }),
    ),
  } as unknown as TenantPrismaService;
  return { service: new PaymentQuickLinksService(controlPlane, tenantPrisma), create, findMany };
}

beforeEach(() =>
  setPaymentUrls({
    redirectUrl: 'https://r/',
    cancelUrl: 'https://c/',
    quickLinkBaseUrl: 'https://vondi.test/l',
  }),
);
afterEach(() => resetPaymentUrlsForTesting());

describe('PaymentQuickLinksService', () => {
  it('generates 6-character codes without ambiguous glyphs', () => {
    const { service } = build();
    for (let i = 0; i < 200; i += 1) {
      expect(service.newCode()).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    }
  });

  it('builds the public URL and the return URLs on the quick link host', () => {
    const { service } = build();
    expect(service.urlFor('K7P3QX')).toBe('https://vondi.test/l/K7P3QX');
    expect(service.returnUrls('K7P3QX')).toEqual({
      successUrl: 'https://vondi.test/l/K7P3QX?result=ok',
      cancelUrl: 'https://vondi.test/l/K7P3QX?result=cancel',
    });
  });

  it('looks up the links of a page of orders in one query, skipping the empty page', async () => {
    const { service, findMany } = build();
    expect(await service.findForOrders('tenant-1', [])).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
    const links = await service.findForOrders('tenant-1', ['order-1', 'order-2']);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(links.get('order-1')).toEqual({ code: 'Q2K7P3', url: 'https://vondi.test/l/Q2K7P3' });
    expect(links.has('order-2')).toBe(false);
  });

  it('is disabled without QUICK_LINK_BASE_URL', () => {
    setPaymentUrls({ redirectUrl: 'https://r/', cancelUrl: 'https://c/', quickLinkBaseUrl: null });
    expect(build().service.enabled()).toBe(false);
  });

  it('resolves a public view with only what the buyer needs', async () => {
    const { service } = build();
    await expect(service.resolvePublic(' k7p3qx ')).resolves.toEqual({
      code: 'K7P3QX',
      merchant: { name: 'ACME Corporation' },
      concept: 'Pastel',
      amount: '450.00',
      currency: 'MXN',
      status: 'PENDING',
      hostedCheckoutUrl: 'https://netpay.test/checkout/abc',
      createdAt: '2026-10-27T10:00:00.000Z',
      updatedAt: '2026-10-27T10:05:00.000Z',
    });
  });

  it('hides the checkout URL once the order is no longer pending', async () => {
    const { service } = build({ order: { ...order, status: 'PAID' } });
    await expect(service.resolvePublic('K7P3QX')).resolves.toMatchObject({
      status: 'PAID',
      hostedCheckoutUrl: null,
    });
  });

  it('answers 404 for unknown codes, malformed codes and inactive tenants', async () => {
    await expect(build({ link: null }).service.resolvePublic('ZZZZZZ')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(build().service.resolvePublic('../x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ tenant: { name: 'x', status: 'SUSPENDED' } }).service.resolvePublic('K7P3QX'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
