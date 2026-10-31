import { jest } from '@jest/globals';
import { PaymentOrdersController } from './payment-orders.controller';

/**
 * POST orders/:id/charge-stored: Netpay orders stay off until the deployment enables
 * NETPAY_MIT_ENABLED; gateway orders (docs 33) go to the gateway without that flag.
 */
describe('PaymentOrdersController.chargeStored', () => {
  const body = {
    clientId: 'cus_1',
    cardToken: 'token_abcdefghij',
    billing: {
      firstName: 'Ana',
      lastName: 'Ruiz',
      email: 'ana@example.com',
      phone: '5512345678',
      address: {},
    },
  } as never;

  function controller(enabled: boolean | undefined, provider = 'NETPAY') {
    const chargeToken = jest.fn(() => Promise.resolve({ orderStatus: 'PAID' }));
    const chargeStoredGateway = jest.fn(() => Promise.resolve({ orderStatus: 'PAID' }));
    const providerOf = jest.fn(() => Promise.resolve(provider));
    const config = enabled === undefined ? undefined : ({ netpayMerchantInitiatedEnabled: enabled } as never);
    const instance = new PaymentOrdersController(
      { chargeToken, chargeStoredGateway, providerOf } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config,
    );
    return { instance, chargeToken, chargeStoredGateway };
  }

  it('refuses while the flag is off or absent', async () => {
    for (const enabled of [undefined, false]) {
      const { instance, chargeToken } = controller(enabled);
      await expect(instance.chargeStored('order-1', body)).rejects.toThrow(/not enabled/);
      expect(chargeToken).not.toHaveBeenCalled();
    }
  });

  it('sends a Stripe order to the gateway without the Netpay flag', async () => {
    const { instance, chargeToken, chargeStoredGateway } = controller(false, 'STRIPE');
    const stripeBody = { clientId: 'cus_1', cardToken: 'pm_123456' } as never;
    await instance.chargeStored('order-1', stripeBody);
    expect(chargeStoredGateway).toHaveBeenCalledWith('order-1', {
      clientId: 'cus_1',
      cardToken: 'pm_123456',
    });
    expect(chargeToken).not.toHaveBeenCalled();
  });

  it('charges as merchant-initiated with the stored card when enabled', async () => {
    const { instance, chargeToken } = controller(true);
    await instance.chargeStored('order-1', body);
    expect(chargeToken).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ clientId: 'cus_1', cardToken: 'token_abcdefghij', merchantInitiated: true }),
    );
  });
});
