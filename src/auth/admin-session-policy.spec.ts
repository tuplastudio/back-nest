import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { routeRequiresStepUp } from './admin-session-policy';
import { ApiKeysController } from '../api-keys/api-keys.controller';
import { OutboundWebhookController } from '../payments/outbound/outbound-webhook.controller';
import { PaymentOrdersController } from '../payments/payment-orders.controller';

/**
 * Which real routes demand a recent MFA from a platform admin (step-up): the
 * payment writes, and the credentials and channels that reach them.
 */
function route(controller: abstract new (...args: never[]) => unknown, handler: string, method: string) {
  return {
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

describe('routeRequiresStepUp', () => {
  it('covers minting, rotating and revoking API keys, not listing them', () => {
    expect(routeRequiresStepUp(route(ApiKeysController, 'create', 'POST'))).toBe(true);
    expect(routeRequiresStepUp(route(ApiKeysController, 'rotate', 'POST'))).toBe(true);
    expect(routeRequiresStepUp(route(ApiKeysController, 'revoke', 'DELETE'))).toBe(true);
    expect(routeRequiresStepUp(route(ApiKeysController, 'list', 'GET'))).toBe(false);
  });

  it('covers outbound webhook writes, not reads', () => {
    expect(routeRequiresStepUp(route(OutboundWebhookController, 'create', 'POST'))).toBe(true);
    expect(routeRequiresStepUp(route(OutboundWebhookController, 'replay', 'POST'))).toBe(true);
    expect(routeRequiresStepUp(route(OutboundWebhookController, 'list', 'GET'))).toBe(false);
  });

  it('still covers payment writes', () => {
    expect(routeRequiresStepUp(route(PaymentOrdersController, 'saveConfig', 'POST'))).toBe(true);
  });
});
