import { jest } from '@jest/globals';
import { NetpayWebhookService } from './netpay-webhook.service';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentOrdersService } from './payment-orders.service';

/**
 * Cash notifications from Netpay (`oxxopay.*`, `cep.*`). Netpay does not sign them,
 * so what is fixed here is that they only locate an order and ask for verification:
 * nothing is settled from the payload.
 */

const SCHEMA = 'tenant_acme_00000001';

function fixture(found: { id: string } | null) {
  const created: Record<string, unknown>[] = [];
  const lookups: unknown[] = [];
  const client = {
    paymentWebhookEvent: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({});
      }),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    paymentOrder: {
      findFirst: jest.fn((args: { where: { OR: unknown[] } }) => {
        lookups.push(args.where.OR);
        return Promise.resolve(found);
      }),
    },
  };
  const tenantPrisma = {
    forTenantTransaction: (_s: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const config = {
    resolveByWebhookToken: () => Promise.resolve({ tenantId: 't1', schemaName: SCHEMA }),
  } as unknown as PaymentConfigService;
  const verifyOrderInSchema = jest.fn((..._a: unknown[]) => Promise.resolve({ status: 'PAID' }));
  const attachCashReferenceInSchema = jest.fn((..._a: unknown[]) => Promise.resolve());
  const orders = { verifyOrderInSchema, attachCashReferenceInSchema } as unknown as PaymentOrdersService;
  return {
    service: new NetpayWebhookService(tenantPrisma, config, orders),
    verifyOrderInSchema,
    attachCashReferenceInSchema,
    lookups,
    created,
  };
}

describe('Netpay cash notifications', () => {
  it('oxxopay.paid is matched by the merchant reference and sent to verification', async () => {
    const f = fixture({ id: 'order-1' });
    await f.service.receive('token', {
      event: 'oxxopay.paid',
      data: { transactionId: 'tx-1', reference: '9201170000000001', merchantRefCode: 'acme_orderref' },
    });
    const keys = JSON.stringify(f.lookups[0]);
    expect(keys).toContain('acme_orderref');
    expect(keys).toContain('paymentReference');
    expect(f.verifyOrderInSchema).toHaveBeenCalledWith(SCHEMA, 'order-1', 'tx-1', 't1');
  });

  it('cep.created attaches the reference and verifies nothing', async () => {
    const f = fixture({ id: 'order-1' });
    await f.service.receive('token', {
      event: 'cep.created',
      data: { transactionId: 'tx-c', reference: '9201170000000009', merchantRefCode: 'acme_orderref' },
    });
    expect(f.attachCashReferenceInSchema).toHaveBeenCalledWith(SCHEMA, 'order-1', '9201170000000009', null);
    expect(f.verifyOrderInSchema).not.toHaveBeenCalled();
  });

  it('oxxopay.new (no transaction yet) records the reference and stops', async () => {
    const f = fixture({ id: 'order-1' });
    await f.service.receive('token', {
      event: 'oxxopay.new',
      data: { reference: '9201170000000001', merchantReferenceCode: 'acme_orderref', amount: 88 },
    });
    expect(f.attachCashReferenceInSchema).toHaveBeenCalled();
    expect(f.verifyOrderInSchema).not.toHaveBeenCalled();
  });

  it('an unknown reference verifies nothing', async () => {
    const f = fixture(null);
    await f.service.receive('token', {
      event: 'oxxopay.paid',
      data: { transactionId: 'tx-x', reference: '1', merchantRefCode: 'nope' },
    });
    expect(f.verifyOrderInSchema).not.toHaveBeenCalled();
  });

  it('keeps no cardholder or personal field from the payload', async () => {
    const f = fixture({ id: 'order-1' });
    await f.service.receive('token', {
      event: 'oxxopay.paid',
      data: {
        transactionId: 'tx-1',
        reference: '1',
        merchantRefCode: 'a',
        customerEmail: 'x@y.mx',
        cardHolderName: 'Juan',
      },
    });
    const stored = JSON.stringify(f.created[0]);
    expect(stored).not.toContain('x@y.mx');
    expect(stored).not.toContain('Juan');
  });
});
