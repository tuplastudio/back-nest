import 'reflect-metadata';
import { jest } from '@jest/globals';
import { PaymentOrdersController, type SavePaymentConfigDto } from './payment-orders.controller';
import type { Principal } from '../tenancy/tenant-context.interface';

/**
 * Replacing a tenant's Netpay keys from a member session needs the member's
 * password (members have no second factor); the platform provisioning path
 * (plane's platform admin) and API keys are unchanged.
 */
function controller() {
  const save = jest.fn(() =>
    Promise.resolve({
      config: { id: 'cfg-1', version: 2, environment: 'SANDBOX', publicKey: 'pk_netpay_a', enabled: true },
      webhookToken: null,
    }),
  );
  const confirmPassword = jest.fn((_userId: string, _password: string | undefined) => Promise.resolve());
  const instance = new PaymentOrdersController(
    {} as never,
    { save } as never,
    {} as never,
    {} as never,
    {} as never,
    { confirmPassword } as never,
  );
  return { instance, save, confirmPassword };
}

const body = {
  publicKey: 'pk_netpay_a',
  secretKey: 'sk_netpay_b',
  environment: 'SANDBOX',
  currentPassword: 'secret',
} as SavePaymentConfigDto;

describe('POST /t/payments/config re-authentication (L1)', () => {
  it('checks the password of a member session before saving', async () => {
    const f = controller();
    const member: Principal = {
      kind: 'tenant-user',
      id: 'member-1',
      displayName: 'Admin',
      role: 'ADMIN' as never,
      tenantId: 't1',
    };
    await f.instance.saveConfig(body, member);
    expect(f.confirmPassword).toHaveBeenCalledWith('member-1', 'secret');
    expect(f.confirmPassword.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0]);
  });

  it('saves nothing when the password is refused', async () => {
    const f = controller();
    f.confirmPassword.mockRejectedValueOnce(new Error('INVALID_CREDENTIALS'));
    const member = {
      kind: 'tenant-user',
      id: 'm',
      displayName: 'x',
      role: 'ADMIN',
      tenantId: 't1',
    } as Principal;
    await expect(f.instance.saveConfig(body, member)).rejects.toThrow('INVALID_CREDENTIALS');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not ask a platform admin (plane provisioning) or an API key', async () => {
    const f = controller();
    const admin: Principal = {
      kind: 'platform-admin',
      id: 'a',
      displayName: 'plane',
      role: 'ADMIN',
      tenantId: 't1',
    };
    const key: Principal = {
      kind: 'api-key',
      id: 'k',
      name: 'cfg',
      tenantId: 't1',
      scopes: ['payments:configure'],
    };
    await f.instance.saveConfig({ ...body, currentPassword: undefined }, admin);
    await f.instance.saveConfig({ ...body, currentPassword: undefined }, key);
    expect(f.confirmPassword).not.toHaveBeenCalled();
    expect(f.save).toHaveBeenCalledTimes(2);
  });
});
