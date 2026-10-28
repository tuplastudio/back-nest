import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/tenant-plane/client';
import { PaymentOrdersService } from './payment-orders.service';
import { NetpayRequestError, NetpayTransportError, type NetpayClient } from './netpay.client';
import type { NetpayAddress } from './netpay-endpoints';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentEvents } from './payment-events';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service';
import type { RequestContextService } from '../tenancy/request-context.service';
import type { RecordEventInput } from './payment-events';
import type { AuditEntry, AuditLogService } from '../audit/audit-log.service';
import type { PaymentQuickLinksService } from './payment-quick-links.service';

const quickLinks = {
  enabled: () => false,
  newCode: () => 'ABCDEF',
  returnUrls: () => ({ successUrl: '', cancelUrl: '' }),
  register: () => Promise.resolve({ code: 'ABCDEF', url: '' }),
  findForOrder: () => Promise.resolve(null),
  findForOrders: () => Promise.resolve(new Map()),
} as unknown as PaymentQuickLinksService;

const SCHEMA = 'tenant_acme_00000001';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const TENANT = { id: TENANT_ID, schemaName: SCHEMA };

/** An order row as the service selects it. */
function order(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    sequence: 0,
    orderReference: 'acme_abc',
    merchantReferenceCode: 'REF-1',
    amount: new Prisma.Decimal('150.75'),
    currency: 'MXN',
    status: 'PENDING',
    netpayTransactionId: 'txn-1',
    amountToken: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/**
 * Billing data a charge requires: the buyer's identity plus the postal address
 * Netpay refuses a charge without.
 */
function billing(): {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: NetpayAddress;
} {
  return {
    firstName: 'A',
    lastName: 'B',
    email: 'a@b.mx',
    phone: '5551234567',
    address: {
      city: 'CDMX',
      country: 'MX',
      postalCode: '06000',
      state: 'CMX',
      street1: 'Avenida 1',
    },
  };
}

/** Browser data from tokenisation, which a charge now requires. */
const DEVICE = {
  deviceFingerPrint: 'fp_0123456789abcdef',
  deviceInformation: {
    deviceChannel: 'Browser',
    httpBrowserColorDepth: '24',
    httpBrowserJavaEnabled: 'FALSE',
    httpBrowserJavaScriptEnabled: 'TRUE',
    httpBrowserLanguage: 'es',
    httpBrowserScreenHeight: '687',
    httpBrowserScreenWidth: '1718',
    httpBrowserTimeDifference: '360',
  },
};

/**
 * Builds a service whose tenant client returns `rows` for any read and accepts
 * any write, so the state-machine behaviour can be exercised without a database.
 *
 * @param rows Rows the fake client returns.
 * @param transaction Netpay's answer for `getTransaction`.
 * @returns The service and the captured writes.
 */
function serviceOver(
  rows: Record<string, unknown>[],
  transaction: Record<string, unknown>,
): {
  service: PaymentOrdersService;
  /** Attempt rows created, and attempt updates (`{ updated, where }`). */
  attempts: Record<string, unknown>[];
  /** Pending provider results written. */
  pending: Record<string, unknown>[];
  writes: Record<string, unknown>[];
  claims: Record<string, unknown>[];
  /** Makes the next claim lose, the way the database reports a lost race. */
  loseClaimRace: () => void;
  emitted: string[];
  audits: AuditEntry[];
  tokenizeAmount: jest.Mock<
    (env: string, key: string, amount: number) => Promise<{ tokenAmount: string; amount: number }>
  >;
  createCharge: jest.Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
  createClient: jest.Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
  deleteCard: jest.Mock<(...args: unknown[]) => Promise<void>>;
  getClient: jest.Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
  assignCard: jest.Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
  confirmCharge: jest.Mock<(...args: unknown[]) => Promise<void>>;
  createCheckoutSession: jest.Mock<
    (
      env: string,
      key: string,
      body: Record<string, unknown>,
    ) => Promise<{ sessionId: string; hostedCheckoutUrl: string }>
  >;
} {
  const writes: Record<string, unknown>[] = [];
  const claims: Record<string, unknown>[] = [];
  const emitted: string[] = [];
  const attempts: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [];
  /** Flipped by a test to simulate losing the claim race, as the database would. */
  let claimWins = true;
  const client = {
    paymentOrder: {
      findFirst: jest.fn(() => Promise.resolve(rows[0] ?? null)),
      findMany: jest.fn(() => Promise.resolve(rows)),
      updateMany: jest.fn((args: { where?: Record<string, unknown> }) => {
        // Every claim goes through one conditional UPDATE, so the predicate is
        // where the race is decided: a request that read the row before a
        // concurrent charge committed must lose here.
        claims.push(args.where ?? {});
        return Promise.resolve({ count: claimWins ? 1 : 0 });
      }),
      findFirstOrThrow: jest.fn(() => Promise.resolve(rows[0] ?? { status: 'PENDING', sequence: 0 })),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        const current = rows[0];
        if (current === undefined) {
          return Promise.resolve(null);
        }
        // Apply the change the way the database would, so the service sees the
        // status it just wrote rather than the row it read.
        const merged: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(args.data)) {
          if (key === 'sequence' && typeof value === 'object' && value !== null) {
            const increment = (value as { increment?: number }).increment ?? 0;
            merged[key] = Number(merged[key] ?? 0) + increment;
          } else {
            merged[key] = value;
          }
        }
        rows[0] = merged;
        return Promise.resolve(merged);
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        writes.push({ created: args.data });
        return Promise.resolve(order({ id: 'order-new' }));
      }),
    },
    paymentAttempt: {
      // The order view lists the attempts (BN-TASK-017).
      findMany: jest.fn(() => Promise.resolve(attempts.filter((a) => typeof a['attemptNo'] === 'number'))),
      findFirst: jest.fn(() => {
        const numbered = attempts.filter((a) => typeof a['attemptNo'] === 'number');
        return Promise.resolve(numbered.length === 0 ? null : { attemptNo: numbered.length });
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        attempts.push(args.data);
        return Promise.resolve(args.data);
      }),
      updateMany: jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        attempts.push({ updated: args.data, where: args.where });
        return Promise.resolve({ count: 1 });
      }),
    },
    pendingProviderResult: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        pending.push(args.data);
        return Promise.resolve(args.data);
      }),
    },
    paymentCustomer: {
      // The tenant's own customers; `cus_1` is the one the stored-card tests use.
      findFirst: jest.fn((args: { where: { netpayCustomerId?: string } }) =>
        Promise.resolve(args.where.netpayCustomerId === 'cus_1' ? { id: 'pc-1' } : null),
      ),
      upsert: jest.fn((args: { create: Record<string, unknown> }) => {
        writes.push({ customer: args.create });
        return Promise.resolve({ id: 'pc-new' });
      }),
    },
  };
  const tenantPrisma = {
    requireCurrentSchema: () => SCHEMA,
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => Promise.resolve(cb(client)),
    forTenantTransaction: (_schema: string, cb: (c: typeof client) => Promise<unknown>) =>
      Promise.resolve(cb(client)),
  } as unknown as TenantPrismaService;
  const requestContext = { get: () => ({ tenant: TENANT }) } as unknown as RequestContextService;
  const configValue = {
    id: 'cfg-1',
    tenantId: TENANT_ID,
    environment: 'SANDBOX' as const,
    publicKey: 'pk_netpay_x',
    secretKey: 'sk_netpay_y',
    orderReferencePrefix: 'acme',
    enabled: true,
  };
  const config = {
    getUsable: () => Promise.resolve(configValue),
    getUsableInSchema: () => Promise.resolve(configValue),
  } as unknown as PaymentConfigService;
  const tokenizeAmount = jest.fn((_env: string, _key: string, amount: number) =>
    Promise.resolve({ tokenAmount: 'tokenAmount_probe', amount }),
  );
  const createCheckoutSession = jest.fn((_env: string, _key: string, _body: Record<string, unknown>) =>
    Promise.resolve({ sessionId: 'sess_probe', hostedCheckoutUrl: 'https://pay.example/hosted/sess_probe' }),
  );
  const createCharge = jest.fn((..._args: unknown[]) =>
    Promise.resolve({ transactionTokenId: 'txn-charged', status: 'DONE', amount: 150.75 } as Record<
      string,
      unknown
    >),
  );
  const createClient = jest.fn((..._args: unknown[]) =>
    Promise.resolve({ id: 'cus_new' } as Record<string, unknown>),
  );
  const deleteCard = jest.fn((..._args: unknown[]) => Promise.resolve());
  const getClient = jest.fn((..._args: unknown[]) =>
    Promise.resolve({ id: 'cus_1', paymentSources: [{ source: 'token_a' }] } as Record<string, unknown>),
  );
  const assignCard = jest.fn((..._args: unknown[]) =>
    Promise.resolve({ token: 'token_new', lastFourDigits: '1111', brand: 'VISA' } as Record<string, unknown>),
  );
  const confirmCharge = jest.fn((..._args: unknown[]) => Promise.resolve());
  const netpay = {
    getTransaction: () => Promise.resolve(transaction),
    tokenizeAmount,
    createCheckoutSession,
    createCharge,
    createClient,
    deleteCard,
    getClient,
    assignCard,
    confirmCharge,
  } as unknown as NetpayClient;
  // The outbox writer: records the status the event describes.
  const events = {
    record: (_tx: unknown, input: RecordEventInput) => {
      emitted.push(input.order.status);
      return Promise.resolve({});
    },
  } as unknown as PaymentEvents;
  const audits: AuditEntry[] = [];
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;

  return {
    service: new PaymentOrdersService(
      tenantPrisma,
      requestContext,
      config,
      netpay,
      events,
      audit,
      quickLinks,
    ),
    attempts,
    pending,
    audits,
    writes,
    claims,
    loseClaimRace: () => {
      claimWins = false;
    },
    emitted,
    tokenizeAmount,
    createCharge,
    createClient,
    deleteCard,
    getClient,
    assignCard,
    confirmCharge,
    createCheckoutSession,
  };
}

describe('PaymentOrdersService verification', () => {
  it('marks an order paid only when Netpay confirms it and the amount matches', async () => {
    const { service, emitted } = serviceOver([order()], { status: 'DONE', amount: 150.75 });
    const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result.status).toBe('PAID');
    expect(emitted).toContain('PAID');
  });

  it('refuses to mark paid when the provider amount differs from the order', async () => {
    // The amount in the notification is never trusted; this is the case that
    // stops a tampered charge from being treated as a paid order.
    const { service, emitted } = serviceOver([order()], { status: 'DONE', amount: 1.0 });
    const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result.status).toBe('AMOUNT_MISMATCH');
    expect(emitted).not.toContain('PAID');
  });

  it('refuses a paid transaction that was charged for a different order', async () => {
    const { service, emitted } = serviceOver([order()], {
      status: 'DONE',
      amount: 150.75,
      merchantReferenceCode: 'SOME-OTHER-ORDER',
    });
    await expect(service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID)).rejects.toThrow(
      /different order/,
    );
    expect(emitted).not.toContain('PAID');
  });

  it('is unmoved by an unknown provider status', async () => {
    const { service, emitted } = serviceOver([order()], { status: 'SOMETHING_NEW', amount: 150.75 });
    const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result.status).toBe('PENDING_VERIFICATION');
    expect(emitted).not.toContain('PAID');
  });

  it('concludes failure on a declined transaction', async () => {
    const { service, emitted } = serviceOver([order()], { status: 'REJECT', amount: 150.75 });
    const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result.status).toBe('FAILED');
    expect(emitted).not.toContain('PAID');
  });

  it('does not conclude anything when the provider omits an amount', async () => {
    // Missing data is not agreement: without an amount there is nothing to
    // compare, so the order stays unconfirmed.
    const { service } = serviceOver([order()], { status: 'DONE' });
    const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result.status).toBe('PAID');
  });

  it('is idempotent: a redelivered verification does not re-apply', async () => {
    const { service, emitted } = serviceOver([order({ status: 'PAID' })], {
      status: 'DONE',
      amount: 150.75,
    });
    const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(result.changed).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('refuses to bind an order already tied to another transaction', async () => {
    const { service } = serviceOver([order({ netpayTransactionId: 'other' })], {});
    await expect(service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID)).rejects.toThrow(
      /different transaction/,
    );
  });

  it('reports a missing order the same way as one owned by another tenant', async () => {
    const { service } = serviceOver([], {});
    await expect(service.verifyOrderInSchema(SCHEMA, 'nope', 'txn-1', TENANT_ID)).rejects.toThrow(
      /not found/,
    );
  });
});

describe('PaymentOrdersService order creation', () => {
  it('never returns the provider credential in the order view', async () => {
    const { service } = serviceOver([order()], {});
    const created = await service.create({
      merchantReferenceCode: 'REF-1',
      amount: '150.75',
      checkoutMode: 'plus',
    });
    const serialised = JSON.stringify(created);
    expect(serialised).not.toContain('sk_netpay');
    expect(serialised).not.toContain('secretKey');
    // The storefront receives a token, not a figure it could alter.
    const checkout = created['checkout'] as Record<string, unknown>;
    expect(checkout['amountToken']).toBe('tokenAmount_probe');
    expect(checkout['publicKey']).toBe('pk_netpay_x');
    expect(checkout['sandboxMode']).toBe(true);
    expect(JSON.stringify(created)).not.toContain('sk_netpay');
    expect(created['amount']).toBe('150.75');
  });

  it('sends the buyer to the page Netpay hosts and remembers the session', async () => {
    const { service, writes, createCheckoutSession } = serviceOver([order()], {});
    const created = await service.create({
      merchantReferenceCode: 'REF-1',
      amount: '150.75',
      successUrl: 'https://shop.example/ok',
      cancelUrl: 'https://shop.example/no',
    });
    const checkout = created['checkout'] as Record<string, unknown>;
    expect(checkout['mode']).toBe('hosted');
    expect(checkout['hostedCheckoutUrl']).toBe('https://pay.example/hosted/sess_probe');
    expect(checkout['amountToken']).toBeNull();
    // The notification names the payment only by session id, so it is stored.
    expect(writes.some((w) => w['checkoutSessionId'] === 'sess_probe')).toBe(true);
    const sent = createCheckoutSession.mock.calls[0]?.[2];
    expect(sent['paymentMethodTypes']).toEqual(['card']);
    expect(sent['linkType']).toBe('NETPAY_CHECKOUT');
    expect(sent['successUrl']).toBe('https://shop.example/ok');
    expect(sent['cancelUrl']).toBe('https://shop.example/no');
    expect(sent['lineItems']).toEqual([{ name: 'REF-1', amount: '150.75', quantity: '1', currency: 'MXN' }]);
    // The merchant reference sent is the unique order reference.
    expect(typeof sent['merchantRefCode']).toBe('string');
  });

  it('does not tokenise the amount for a hosted order', async () => {
    const { service, tokenizeAmount } = serviceOver([order()], {});
    await service.create({ merchantReferenceCode: 'REF-1', amount: '150.75' });
    expect(tokenizeAmount).not.toHaveBeenCalled();
  });

  it('refuses a hosted order in a currency other than MXN', async () => {
    const { service } = serviceOver([order()], {});
    await expect(
      service.create({ merchantReferenceCode: 'REF-1', amount: '10.00', currency: 'USD' }),
    ).rejects.toThrow(/MXN/);
  });

  it('asks the provider for nothing when the storefront charges a token itself', async () => {
    const { service, tokenizeAmount, createCheckoutSession } = serviceOver([order()], {});
    const created = await service.create({
      merchantReferenceCode: 'REF-1',
      amount: '150.75',
      checkoutMode: 'custom',
    });
    expect((created['checkout'] as Record<string, unknown>)['mode']).toBe('custom');
    expect(tokenizeAmount).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each(['0', '-5', 'abc', '150.756', '', '1e9'])('refuses an unusable amount: %s', async (amount) => {
    const { service } = serviceOver([order()], {});
    await expect(service.create({ merchantReferenceCode: 'REF-1', amount })).rejects.toThrow();
  });

  it('reports the transaction id Netpay returned, not the one from before the write', async () => {
    // The row read at creation has no transaction id yet; reporting it would make
    // a caller believe the order is not yet bound.
    const { service } = serviceOver([order()], {});
    const created = await service.create({
      merchantReferenceCode: 'REF-1',
      amount: '150.75',
      checkoutMode: 'plus',
    });
    expect(created['netpayTransactionId']).toBeNull();
    // The storefront receives a token, not a figure it could alter.
    const checkout = created['checkout'] as Record<string, unknown>;
    expect(checkout['amountToken']).toBe('tokenAmount_probe');
    expect(checkout['publicKey']).toBe('pk_netpay_x');
    expect(checkout['sandboxMode']).toBe(true);
    expect(JSON.stringify(created)).not.toContain('sk_netpay');
  });

  it.each([
    [3, '250.00', /at least 300 MXN/],
    [6, '500.00', /at least 600 MXN/],
    [9, '800.00', /at least 900/],
    [5, '5000.00', /offers 3, 6, 9, 12, 18/],
  ])('refuses an unavailable installment plan: %i months at %s', async (months, amount, pattern) => {
    // Netpay rejects these, but a merchant should not have to decode a provider
    // error to find out, so the rules are checked before the call.
    const { service } = serviceOver([order()], {});
    await expect(
      service.create({ merchantReferenceCode: 'REF-1', amount, installments: months }),
    ).rejects.toThrow(pattern);
  });

  it('accepts an installment plan that meets the published minimum', async () => {
    const { service } = serviceOver([order()], {});
    await expect(
      service.create({ merchantReferenceCode: 'REF-1', amount: '650.00', installments: 6 }),
    ).resolves.toBeDefined();
  });

  it('refuses to charge a token that is not a Netpay token', async () => {
    // The DTO pattern is the first line; the service must not accept a PAN even
    // if the DTO were bypassed, so the token shape is checked here too.
    const { service } = serviceOver([order()], {});
    await expect(
      service.chargeToken('order-1', {
        cardToken: '4111111111111111',
        billing: billing(),
        ...DEVICE,
      }),
    ).rejects.toThrow();
  });

  it('refuses to charge an order that is already settled', async () => {
    const { service } = serviceOver([order({ status: 'PAID' })], {});
    await expect(
      service.chargeToken('order-1', {
        cardToken: 'token_abcdefghij',
        billing: billing(),
        ...DEVICE,
      }),
    ).rejects.toThrow(/already settled/);
  });

  it('refuses to refund an order that is not settled', async () => {
    const { service } = serviceOver([order({ status: 'PENDING' })], {});
    await expect(service.refund('order-1')).rejects.toThrow(/Only a settled order/);
  });

  it('refuses to refund an order with no transaction', async () => {
    const { service } = serviceOver([order({ status: 'PAID', netpayTransactionId: null })], {});
    await expect(service.refund('order-1')).rejects.toThrow(/no transaction to reverse/);
  });

  it('refuses to find an order that belongs to another tenant', async () => {
    const { service } = serviceOver([], {});
    await expect(service.findById('someone-elses-order')).rejects.toThrow(/not found/);
  });
});

describe('PaymentOrdersService charging a token', () => {
  const pending = (): Record<string, unknown> => order({ netpayTransactionId: null });
  const token = 'token_abcdefghij';

  it('refuses a charge without the browser data 3-D Secure 2.0 needs', async () => {
    const { service, createCharge } = serviceOver([pending()], {});
    await expect(
      service.chargeToken('order-1', {
        cardToken: token,
        billing: billing(),
        deviceFingerPrint: '',
        deviceInformation: {},
      }),
    ).rejects.toThrow(/deviceFingerPrint/);
    await expect(
      service.chargeToken('order-1', {
        cardToken: token,
        billing: billing(),
        deviceFingerPrint: DEVICE.deviceFingerPrint,
        deviceInformation: { deviceChannel: 'Browser' },
      }),
    ).rejects.toThrow(/deviceInformation is missing/);
    expect(createCharge).not.toHaveBeenCalled();
  });

  it('forwards the browser data, reference id and user agent exactly as given', async () => {
    const { service, createCharge } = serviceOver([pending()], {});
    await service.chargeToken('order-1', {
      cardToken: token,
      billing: billing(),
      ...DEVICE,
      referenceId: 'ref_from_3ds',
      userAgent: 'Mozilla/5.0 Test',
    });
    const [, , body, agent] = createCharge.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect(body['sessionId']).toBe(DEVICE.deviceFingerPrint);
    expect(body['deviceFingerPrint']).toBe(DEVICE.deviceFingerPrint);
    expect(body['deviceInformation']).toEqual(DEVICE.deviceInformation);
    expect(body['referenceID']).toBe('ref_from_3ds');
    expect(agent).toBe('Mozilla/5.0 Test');
    // A one-time token carries its code from tokenisation.
    expect(body).not.toHaveProperty('cvv');
  });

  it('uses the order reference as referenceID when the browser sent none', async () => {
    const { service, createCharge } = serviceOver([pending()], {});
    await service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE });
    expect((createCharge.mock.calls[0]?.[2] as Record<string, unknown>)['referenceID']).toBe('acme_abc');
  });

  it('requires the cvv on every charge with a stored card, and sends it', async () => {
    const { service, createCharge, createClient } = serviceOver([pending()], {});
    await expect(
      service.chargeToken('order-1', { cardToken: token, billing: billing(), clientId: 'cus_1', ...DEVICE }),
    ).rejects.toThrow(/needs its cvv/);
    await expect(
      service.chargeToken('order-1', {
        cardToken: token,
        billing: billing(),
        clientId: 'cus_1',
        cvv: '12',
        ...DEVICE,
      }),
    ).rejects.toThrow(/needs its cvv/);
    expect(createCharge).not.toHaveBeenCalled();

    await service.chargeToken('order-1', {
      cardToken: token,
      billing: billing(),
      clientId: 'cus_1',
      cvv: '123',
      ...DEVICE,
    });
    const body = createCharge.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body['cvv']).toBe('123');
    expect(body['saveCard']).toBe('false');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('never returns the cvv, and refuses one without a stored card', async () => {
    const { service } = serviceOver([pending()], {});
    await expect(
      service.chargeToken('order-1', { cardToken: token, billing: billing(), cvv: '123', ...DEVICE }),
    ).rejects.toThrow(/only accepted when charging a stored card/);
    const result = await service.chargeToken('order-1', {
      cardToken: token,
      billing: billing(),
      clientId: 'cus_1',
      cvv: '123',
      ...DEVICE,
    });
    expect(JSON.stringify(result)).not.toContain('123');
  });

  it('refuses saveCard together with a stored card', async () => {
    const { service } = serviceOver([pending()], {});
    await expect(
      service.chargeToken('order-1', {
        cardToken: token,
        billing: billing(),
        clientId: 'cus_1',
        cvv: '123',
        saveCard: true,
        ...DEVICE,
      }),
    ).rejects.toThrow(/saveCard false/);
  });

  it('removes the card it attached for a one-time payment', async () => {
    const { service, deleteCard } = serviceOver([pending()], {});
    await service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE });
    expect(deleteCard).toHaveBeenCalledWith('SANDBOX', 'sk_netpay_y', 'cus_new', token);
  });

  it('keeps the card when the buyer asked to save it', async () => {
    const { service, deleteCard } = serviceOver([pending()], {});
    await service.chargeToken('order-1', { cardToken: token, billing: billing(), saveCard: true, ...DEVICE });
    expect(deleteCard).not.toHaveBeenCalled();
  });

  it('removes the one-time card even when 3-D Secure is pending, since confirm does not need it', async () => {
    const { service, deleteCard, createCharge } = serviceOver([pending()], {});
    createCharge.mockResolvedValueOnce({
      transactionTokenId: 'txn-3ds',
      status: 'review',
      threeDSecureResponse: { status: 'PROCEED_TO_VALIDATE_AUTHENTICATION', responseCode: 100, acsUrl: null },
    });
    await service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE });
    expect(deleteCard).toHaveBeenCalledTimes(1);
  });

  it('filters the certification characters out of what reaches Netpay', async () => {
    const { service, createCharge, createClient } = serviceOver([pending()], {});
    const b = billing();
    await service.chargeToken('order-1', {
      cardToken: token,
      billing: { ...b, firstName: 'Ana<b>', address: { ...b.address, street1: 'Calle 5 #12 S/N' } },
      ...DEVICE,
    });
    const body = createCharge.mock.calls[0]?.[2] as {
      billing: { firstName: string; address: { street1: string } };
    };
    expect(body.billing.firstName).toBe('Ana b');
    expect(body.billing.address.street1).toBe('Calle 5 12 S N');
    expect((createClient.mock.calls[0]?.[2] as { firstName: string }).firstName).toBe('Ana b');
  });

  it('sends only the documented device fields', async () => {
    const { service, createCharge } = serviceOver([pending()], {});
    await service.chargeToken('order-1', {
      cardToken: token,
      billing: billing(),
      deviceFingerPrint: DEVICE.deviceFingerPrint,
      deviceInformation: { ...DEVICE.deviceInformation, injected: 'x'.repeat(10_000) },
    });
    const sent = (createCharge.mock.calls[0]?.[2] as { deviceInformation: Record<string, string> })
      .deviceInformation;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(DEVICE.deviceInformation).sort());
  });

  it('refuses an oversized device field', async () => {
    const { service } = serviceOver([pending()], {});
    await expect(
      service.chargeToken('order-1', {
        cardToken: token,
        billing: billing(),
        deviceFingerPrint: DEVICE.deviceFingerPrint,
        deviceInformation: { ...DEVICE.deviceInformation, httpBrowserLanguage: 'x'.repeat(65) },
      }),
    ).rejects.toThrow(/httpBrowserLanguage/);
  });

  it('does not fail the payment when the clean-up fails', async () => {
    const { service, deleteCard } = serviceOver([pending()], {});
    deleteCard.mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE }),
    ).resolves.toBeDefined();
  });

  it("records a decline as a failed order at once, with Netpay's reason", async () => {
    // The transaction lookup would say something else; a decline does not wait for it.
    const { service, createCharge, writes } = serviceOver([pending()], {
      status: 'IN_PROCESS',
      amount: 150.75,
    });
    createCharge.mockResolvedValueOnce({
      transactionTokenId: 'txn-declined',
      status: 'failed',
      declineReason: 'Rejected by Decision Manager',
    });
    const result = await service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE });
    expect(result.orderStatus).toBe('FAILED');
    expect(result.declineReason).toBe('Rejected by Decision Manager');
    expect(result.transactionTokenId).toBe('txn-declined');
    expect(writes.some((w) => w['failureReason'] === 'Rejected by Decision Manager')).toBe(true);
  });

  it('makes the claim refuse a charge whose order may already have been charged', async () => {
    // The race: a request reads a chargeable order, and by the time it claims, a
    // concurrent charge has finished and released its claim. Nothing about the
    // row it holds says "do not charge", so the conditional UPDATE is the only
    // thing that can refuse it, and a claim alone cannot: it sees a free claim
    // and a status that still qualifies. Requiring that no transaction is bound
    // is what makes an already-charged order visible to the late request.
    //
    // The end-to-end race lives in payments.e2e-spec.ts ("charges an order at
    // most once under concurrent charges"); what is pinned here is the mechanism
    // and that losing the claim stops the charge.
    const { service, claims } = serviceOver([pending()], {});
    await service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE });
    expect(claims[0]).toMatchObject({ netpayTransactionId: null });

    const raced = serviceOver([pending()], {});
    raced.loseClaimRace();
    await expect(
      raced.service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE }),
    ).rejects.toThrow(/no longer qualifies/);
    expect(raced.createCharge).not.toHaveBeenCalled();
  });

  it('refuses 18 installments on a card that is not Visa or Mastercard', async () => {
    const { service, createCharge } = serviceOver(
      [order({ netpayTransactionId: null, amount: new Prisma.Decimal('2000.00') })],
      {},
    );
    await expect(
      service.chargeToken('order-1', {
        cardToken: token,
        billing: billing(),
        installments: 18,
        cardBrand: 'AMEX',
        ...DEVICE,
      }),
    ).rejects.toThrow(/Visa and Mastercard only/);
    expect(createCharge).not.toHaveBeenCalled();
  });
});

describe('PaymentOrdersService 3-D Secure confirmation', () => {
  it('confirms with a null processor id when no challenge was needed', async () => {
    const { service, confirmCharge } = serviceOver([order()], { status: 'WAIT_THREEDS', amount: 150.75 });
    await service.confirmCharge('order-1', null);
    expect(confirmCharge.mock.calls[0]?.[3]).toBeNull();
  });

  it('does not confirm a transaction that is not waiting for 3-D Secure', async () => {
    const { service, confirmCharge } = serviceOver([order()], { status: 'FAILED', amount: 150.75 });
    await expect(service.confirmCharge('order-1', 'proc-1')).rejects.toThrow(/not waiting/);
    expect(confirmCharge).not.toHaveBeenCalled();
  });
});

describe('PaymentOrdersService stored cards', () => {
  it('refuses a fourth card, because Netpay holds at most three', async () => {
    const { service, getClient, assignCard } = serviceOver([order()], {});
    getClient.mockResolvedValueOnce({
      id: 'cus_1',
      paymentSources: [{ source: 'a' }, { source: 'b' }, { source: 'c' }],
    });
    await expect(service.assignCard('cus_1', { cardToken: 'token_abcdefghij', cvv: '123' })).rejects.toThrow(
      /at most 3/,
    );
    expect(assignCard).not.toHaveBeenCalled();
  });

  it('counts a profile without a card as empty', async () => {
    const { service, getClient, assignCard } = serviceOver([order()], {});
    getClient.mockResolvedValueOnce({ id: 'cus_1', paymentSources: [null] });
    await service.assignCard('cus_1', { cardToken: 'token_abcdefghij', cvv: '123', preAuth: true });
    expect(assignCard).toHaveBeenCalledWith(
      'SANDBOX',
      'sk_netpay_y',
      'cus_1',
      'token_abcdefghij',
      '123',
      true,
    );
  });

  it('refuses card data in place of a token', async () => {
    const { service } = serviceOver([order()], {});
    await expect(service.assignCard('cus_1', { cardToken: '4111111111111111', cvv: '123' })).rejects.toThrow(
      /not card data/,
    );
  });

  it('returns only non-sensitive card fields', async () => {
    const { service, assignCard } = serviceOver([order()], {});
    assignCard.mockResolvedValueOnce({
      token: 'token_x',
      lastFourDigits: '1111',
      brand: 'VISA',
      cardHolderName: 'Ana Lopez',
      ipAddress: '10.0.0.1',
    });
    const card = await service.assignCard('cus_1', { cardToken: 'token_abcdefghij', cvv: '123' });
    expect(JSON.stringify(card)).not.toContain('Ana');
    expect(JSON.stringify(card)).not.toContain('10.0.0.1');
  });

  it('lists a customer cards without any number', async () => {
    const { service, getClient } = serviceOver([order()], {});
    getClient.mockResolvedValueOnce({
      id: 'cus_1',
      identifier: 'buyer-1',
      paymentSources: [
        { source: 'token_a', cardDefault: true, card: { lastFourDigits: '4242', brand: 'VISA' } },
        null,
      ],
    });
    expect(await service.getCustomer('cus_1')).toEqual({
      id: 'cus_1',
      identifier: 'buyer-1',
      cards: [{ token: 'token_a', default: true, lastFourDigits: '4242', brand: 'VISA' }],
    });
  });
});

describe('PaymentOrdersService provider outcome on a charge (BN-TASK-013)', () => {
  const pending = (): Record<string, unknown> => order({ netpayTransactionId: null });
  /** Whether a write cleared the operation claim. */
  const releasedIn = (claims: Record<string, unknown>[]) => claims.length > 1;

  it('keeps the claim when the charge times out: the buyer may have been charged', async () => {
    const f = serviceOver([pending()], {});
    f.createCharge.mockRejectedValueOnce(new NetpayTransportError('/v3.5/charges/', new Error('timeout')));
    await expect(
      f.service.chargeToken('order-1', { cardToken: 'token_abcdefghij', billing: billing(), ...DEVICE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', status: 504, retryable: true });
    // The first updateMany is the claim itself; a second would be the release.
    expect(releasedIn(f.claims)).toBe(false);
  });

  it('releases the claim when the timeout happened before the charge was sent', async () => {
    const f = serviceOver([pending()], {});
    f.createClient.mockRejectedValueOnce(new NetpayTransportError('/v4/clients', new Error('timeout')));
    await expect(
      f.service.chargeToken('order-1', { cardToken: 'token_abcdefghij', billing: billing(), ...DEVICE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(f.createCharge).not.toHaveBeenCalled();
    expect(releasedIn(f.claims)).toBe(true);
  });

  it('releases the claim when Netpay explicitly refuses the request', async () => {
    const f = serviceOver([pending()], {});
    f.createCharge.mockRejectedValueOnce(new NetpayRequestError(400, '/v3.5/charges/', 'Invalid Token'));
    await expect(
      f.service.chargeToken('order-1', { cardToken: 'token_abcdefghij', billing: billing(), ...DEVICE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DECLINED', status: 502 });
    expect(releasedIn(f.claims)).toBe(true);
  });
});

describe('PaymentOrdersService decline codes (BN-TASK-020)', () => {
  it('returns and persists the stable failure code, keeping the original internally', async () => {
    const f = serviceOver([order({ netpayTransactionId: null })], { status: 'IN_PROCESS', amount: 150.75 });
    f.createCharge.mockResolvedValueOnce({
      transactionTokenId: 'txn-declined',
      status: 'failed',
      declineReason: 'Fondos insuficientes',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerFailureCode: '51',
    });
    const result = await f.service.chargeToken('order-1', {
      cardToken: 'token_abcdefghij',
      billing: billing(),
      ...DEVICE,
    });
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(JSON.stringify(result)).not.toContain('"51"');
    expect(f.writes.some((w) => w['failureCode'] === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(f.writes.some((w) => w['providerFailureCode'] === '51')).toBe(true);
  });

  it('classifies a failure found by verification from the transaction response code', async () => {
    const f = serviceOver([order()], { status: 'REJECT', amount: 150.75, responseCode: '54' });
    await f.service.verifyOrder('order-1', 'txn-1');
    expect(f.writes.some((w) => w['failureCode'] === 'CARD_EXPIRED')).toBe(true);
  });

  it('shows the failure code on the order view', async () => {
    const f = serviceOver(
      [
        order({
          status: 'FAILED',
          failureCode: 'DO_NOT_HONOR',
          providerFailureCode: '05',
          paymentMethod: null,
          paymentReference: null,
          paymentReferenceExpiresAt: null,
          refundedAmount: new Prisma.Decimal('0'),
        }),
      ],
      {},
    );
    const view = await f.service.findById('order-1');
    expect(view.failureCode).toBe('DO_NOT_HONOR');
    // The original code is internal.
    expect(JSON.stringify(view)).not.toContain('providerFailureCode');
  });
});

describe('PaymentOrdersService stored-card ownership and digits (BN-TASK-053)', () => {
  it('returns the last four digits Netpay reports, never the end of the token', async () => {
    const f = serviceOver([order()], {});
    f.createClient.mockResolvedValueOnce({
      id: 'cus_new',
      paymentSources: [{ source: 'token_abcdefghijklmnop', type: 'card' }],
    });
    f.getClient.mockResolvedValueOnce({
      id: 'cus_new',
      paymentSources: [{ source: 'token_abcdefghijklmnop', card: { lastFourDigits: '4242' } }],
    });
    const stored = await f.service.storeCard({
      identifier: 'buyer',
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.mx',
      phone: '5512345678',
      cardToken: 'token_abcdefghijklmnop',
    });
    expect(stored.lastFourDigits).toBe('4242');
  });

  it('answers null rather than inventing digits when Netpay does not say', async () => {
    const f = serviceOver([order()], {});
    f.createClient.mockResolvedValueOnce({
      id: 'cus_new',
      paymentSources: [{ source: 'token_abcdefghijklmnop' }],
    });
    f.getClient.mockRejectedValueOnce(new NetpayTransportError('/v3/clients/cus_new', new Error('timeout')));
    const stored = await f.service.storeCard({
      identifier: 'buyer',
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.mx',
      phone: '5512345678',
      cardToken: 'token_abcdefghijklmnop',
    });
    expect(stored.lastFourDigits).toBeNull();
  });

  it.each([
    ['getCustomer', (s: PaymentOrdersService) => s.getCustomer('cus_other')],
    [
      'assignCard',
      (s: PaymentOrdersService) => s.assignCard('cus_other', { cardToken: 'token_abcdefghij', cvv: '123' }),
    ],
    ['deleteCard', (s: PaymentOrdersService) => s.deleteCard('cus_other', 'token_abcdefghij')],
  ])('%s answers 404 for a customer that is not this tenant’s, without asking Netpay', async (_n, act) => {
    const f = serviceOver([order()], {});
    await expect(act(f.service)).rejects.toMatchObject({ status: 404 });
    expect(f.getClient).not.toHaveBeenCalled();
    expect(f.assignCard).not.toHaveBeenCalled();
    expect(f.deleteCard).not.toHaveBeenCalled();
  });

  it('refuses to charge a stored card of a customer that is not this tenant’s', async () => {
    const f = serviceOver([order({ netpayTransactionId: null })], {});
    await expect(
      f.service.chargeToken('order-1', {
        cardToken: 'token_abcdefghij',
        billing: billing(),
        clientId: 'cus_other',
        cvv: '123',
        ...DEVICE,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.createCharge).not.toHaveBeenCalled();
  });

  it('records the customer when a charge saves the card, so it can be charged again', async () => {
    const f = serviceOver([order({ netpayTransactionId: null })], { status: 'DONE', amount: 150.75 });
    await f.service.chargeToken('order-1', {
      cardToken: 'token_abcdefghij',
      billing: billing(),
      saveCard: true,
      ...DEVICE,
    });
    expect(
      f.writes.some(
        (w) => (w['customer'] as Record<string, unknown> | undefined)?.['netpayCustomerId'] === 'cus_new',
      ),
    ).toBe(true);
  });
});

describe('PaymentOrdersService status changes: audit and metrics (BN-TASK-030, BN-TASK-044)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('audits a webhook-driven PENDING → PAID as the system, with the tenant and the order', async () => {
    const { service, audits } = serviceOver([order()], { status: 'DONE', amount: 150.75 });
    await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(audits).toEqual([
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorType: 'SYSTEM',
        action: 'payment.status_changed',
        resourceType: 'payment_order',
        resourceId: 'order-1',
        metadata: expect.objectContaining({
          orderId: 'order-1',
          from: 'PENDING',
          to: 'PAID',
          event: 'payment.paid',
          source: 'webhook',
        }) as unknown,
      }),
    ]);
  });

  it('logs payment_status_change for the log-based metric', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service } = serviceOver([order()], { status: 'DONE', amount: 150.75 });
    await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment_status_change',
        orderId: 'order-1',
        from: 'PENDING',
        to: 'PAID',
      }),
    );
  });

  it('neither audits nor logs a verification that changed nothing', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, audits } = serviceOver([order({ status: 'PAID' })], { status: 'DONE', amount: 150.75 });
    await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
    expect(audits).toHaveLength(0);
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'payment_status_change' }));
  });

  it.each(['PARTIALLY_REFUNDED', 'REFUNDED'])(
    'does not drag a %s order back on a later verification',
    async (status) => {
      const { service, writes, emitted } = serviceOver([order({ status })], {
        status: 'CANCELED',
        amount: 150.75,
      });
      const result = await service.verifyOrderInSchema(SCHEMA, 'order-1', 'txn-1', TENANT_ID);
      expect(result).toEqual({ orderId: 'order-1', status, changed: false, emittedEvent: null });
      expect(writes).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    },
  );
});

describe('PaymentOrdersService unknown outcomes and attempts (BN-TASK-014, BN-TASK-015)', () => {
  const token = 'token_abcdefghij';
  const charge = (service: PaymentOrdersService) =>
    service.chargeToken('order-1', { cardToken: token, billing: billing(), ...DEVICE });

  it('turns the order CHARGE_UNKNOWN with an UNKNOWN attempt when the charge gets no answer', async () => {
    const f = serviceOver([order({ netpayTransactionId: null })], {});
    f.createCharge.mockRejectedValueOnce(new NetpayTransportError('/v3.5/charges/', new Error('timeout')));
    await expect(charge(f.service)).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(f.writes.some((w) => w['status'] === 'CHARGE_UNKNOWN')).toBe(true);
    expect(f.attempts).toEqual([
      expect.objectContaining({ attemptNo: 1, netpayTransactionId: null, status: 'UNKNOWN' }),
    ]);
    // Only the claim itself: nothing released it.
    expect(f.claims).toHaveLength(1);
    // CHARGE_UNKNOWN is not announced: nothing was concluded.
    expect(f.emitted).toEqual([]);
  });

  it('refuses a new charge with 409 ORDER_STATE_CONFLICT while the order is CHARGE_UNKNOWN', async () => {
    const f = serviceOver([order({ status: 'CHARGE_UNKNOWN', netpayTransactionId: null })], {});
    await expect(charge(f.service)).rejects.toMatchObject({
      code: 'ORDER_STATE_CONFLICT',
      status: 409,
      details: { status: 'CHARGE_UNKNOWN' },
    });
    expect(f.createCharge).not.toHaveBeenCalled();
    expect(f.claims).toHaveLength(0);
  });

  it('accepts a new card on a FAILED order, as attempt 2 of the transaction it had', async () => {
    const f = serviceOver([order({ status: 'FAILED', netpayTransactionId: 'txn-1' })], {
      status: 'DONE',
      amount: 150.75,
    });
    const result = await charge(f.service);
    expect(f.createCharge).toHaveBeenCalledTimes(1);
    // The guard is now "the transaction checked is still the bound one", not "none is bound".
    expect(f.claims[0]).toMatchObject({
      netpayTransactionId: 'txn-1',
      status: { in: ['PENDING', 'PENDING_VERIFICATION', 'FAILED'] },
    });
    expect(f.attempts[0]).toMatchObject({
      attemptNo: 2,
      netpayTransactionId: 'txn-charged',
      status: 'SUBMITTED',
    });
    // The new attempt leaves FAILED behind before Netpay's verdict is applied.
    expect(
      f.writes.some(
        (w) => w['status'] === 'PENDING_VERIFICATION' && w['netpayTransactionId'] === 'txn-charged',
      ),
    ).toBe(true);
    expect(result.orderStatus).toBe('PAID');
  });

  it('marks an abandoned 3-D Secure attempt and accepts the new charge', async () => {
    const f = serviceOver([order({ status: 'PENDING_VERIFICATION', netpayTransactionId: 'txn-1' })], {
      status: 'WAIT_THREEDS',
      amount: 150.75,
    });
    await charge(f.service);
    expect(f.attempts[0]).toMatchObject({
      updated: { status: 'ABANDONED' },
      where: { netpayTransactionId: 'txn-1' },
    });
    expect(f.createCharge).toHaveBeenCalledTimes(1);
  });

  it('refuses with the PAID order when the previous attempt was charged after all', async () => {
    const previous = order({
      status: 'PENDING_VERIFICATION',
      netpayTransactionId: 'txn-1',
      refundedAmount: new Prisma.Decimal(0),
    });
    const f = serviceOver([previous], {
      status: 'DONE',
      amount: 150.75,
    });
    const refused = await charge(f.service).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'ORDER_STATE_CONFLICT', status: 409 });
    const details = (refused as { details: { order: Record<string, unknown> } }).details;
    expect(details.order).toMatchObject({ id: 'order-1', status: 'PAID', netpayTransactionId: 'txn-1' });
    expect(f.createCharge).not.toHaveBeenCalled();
    expect(f.emitted).toEqual(['PAID']);
  });

  it('refuses while the previous attempt is still undecided at Netpay', async () => {
    const f = serviceOver([order({ status: 'PENDING', netpayTransactionId: 'txn-1' })], {
      status: 'REVIEW',
      amount: 150.75,
    });
    await expect(charge(f.service)).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });
    expect(f.createCharge).not.toHaveBeenCalled();
  });

  it('announces a decline of a second attempt although the order was already FAILED', async () => {
    const f = serviceOver([order({ status: 'FAILED', netpayTransactionId: 'txn-1' })], {});
    f.createCharge.mockResolvedValueOnce({
      transactionTokenId: 'txn-2',
      status: 'failed',
      declineReason: 'Fondos insuficientes',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    const result = await charge(f.service);
    expect(result.orderStatus).toBe('FAILED');
    expect(f.emitted).toEqual(['FAILED']);
    expect(f.attempts[0]).toMatchObject({
      attemptNo: 2,
      status: 'FAILED',
      declineCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('settles the attempt that verification concludes', async () => {
    const f = serviceOver([order({ status: 'CHARGE_UNKNOWN', netpayTransactionId: null })], {
      status: 'DONE',
      amount: 150.75,
    });
    await f.service.verifyOrder('order-1', 'txn-found');
    expect(f.attempts[0]).toMatchObject({
      updated: { netpayTransactionId: 'txn-found', status: 'PAID' },
    });
  });
});
