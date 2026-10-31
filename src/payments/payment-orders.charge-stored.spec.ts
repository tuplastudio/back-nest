import { jest } from '@jest/globals';
import { PaymentOrdersController } from './payment-orders.controller';

/** POST orders/:id/charge-stored stays off until the deployment enables NETPAY_MIT_ENABLED. */
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

  function controller(enabled: boolean | undefined) {
    const chargeToken = jest.fn(() => Promise.resolve({ orderStatus: 'PAID' }));
    const config = enabled === undefined ? undefined : ({ netpayMerchantInitiatedEnabled: enabled } as never);
    const instance = new PaymentOrdersController(
      { chargeToken } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config,
    );
    return { instance, chargeToken };
  }

  it('refuses while the flag is off or absent', () => {
    for (const enabled of [undefined, false]) {
      const { instance, chargeToken } = controller(enabled);
      expect(() => instance.chargeStored('order-1', body)).toThrow(/not enabled/);
      expect(chargeToken).not.toHaveBeenCalled();
    }
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
