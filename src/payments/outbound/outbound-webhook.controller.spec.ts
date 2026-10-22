import 'reflect-metadata';
import { jest } from '@jest/globals';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreateWebhookEndpointDto,
  OutboundWebhookController,
  ToggleWebhookEndpointDto,
} from './outbound-webhook.controller';
import { ALL_PAYMENT_EVENTS } from '../payment-events';
import type { OutboundWebhookService } from './outbound-webhook.service';

/**
 * The controller is a thin adapter: these tests pin what it forwards to the
 * service and what the DTOs refuse before the service is reached. Route
 * permissions and scopes are covered by rbac-audit.routes.spec.ts.
 */
function harness() {
  const service = {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({ id: 'ep-1', secret: 'whsec_x' })),
    rotateSecret: jest.fn(() => Promise.resolve({ id: 'ep-1', secret: 'whsec_y' })),
    endRotation: jest.fn(() => Promise.resolve()),
    setEnabled: jest.fn(() => Promise.resolve()),
    deliveries: jest.fn(() => Promise.resolve([])),
    replay: jest.fn(() => Promise.resolve()),
  };
  const controller = new OutboundWebhookController(service as unknown as OutboundWebhookService);
  return { controller, service };
}

describe('OutboundWebhookController', () => {
  it('lists endpoints', async () => {
    const { controller, service } = harness();
    await expect(controller.list()).resolves.toEqual([]);
    expect(service.list).toHaveBeenCalledTimes(1);
  });

  it('forwards only the known fields of a new endpoint', async () => {
    const { controller, service } = harness();
    const body = Object.assign(new CreateWebhookEndpointDto(), {
      url: 'https://hooks.example.com/x?a=1',
      description: 'ERP',
      events: ['payment.paid'],
      tenantId: 'someone-else',
    });
    await controller.create(body);
    expect(service.create).toHaveBeenCalledWith({
      url: 'https://hooks.example.com/x?a=1',
      description: 'ERP',
      events: ['payment.paid'],
    });
  });

  it('lists the subscribable events', () => {
    expect(harness().controller.availableEvents()).toEqual({ events: ALL_PAYMENT_EVENTS });
  });

  it('forwards rotation, end of rotation, toggling, deliveries and replay', async () => {
    const { controller, service } = harness();
    await controller.rotateSecret('ep-1');
    await controller.endRotation('ep-1');
    await controller.setStatus('ep-1', Object.assign(new ToggleWebhookEndpointDto(), { enabled: false }));
    await controller.deliveries('ep-1');
    await controller.replay('d-1');
    expect(service.rotateSecret).toHaveBeenCalledWith('ep-1');
    expect(service.endRotation).toHaveBeenCalledWith('ep-1');
    expect(service.setEnabled).toHaveBeenCalledWith('ep-1', false);
    expect(service.deliveries).toHaveBeenCalledWith('ep-1');
    expect(service.replay).toHaveBeenCalledWith('d-1');
  });

  describe('CreateWebhookEndpointDto', () => {
    const errorsFor = async (plain: Record<string, unknown>) =>
      (await validate(plainToInstance(CreateWebhookEndpointDto, plain))).map((e) => e.property);

    it('accepts a URL with a query string', async () => {
      await expect(
        errorsFor({ url: 'https://hooks.example.com/x?a=1', events: ['payment.paid'] }),
      ).resolves.toEqual([]);
    });

    it('refuses a value without a scheme, an empty event list and an overlong description', async () => {
      const errors = await errorsFor({
        url: 'hooks.example.com/x',
        events: [],
        description: 'x'.repeat(161),
      });
      expect(errors.sort()).toEqual(['description', 'events', 'url']);
    });
  });

  it('ToggleWebhookEndpointDto requires a boolean', async () => {
    const errors = await validate(plainToInstance(ToggleWebhookEndpointDto, { enabled: 'yes' }));
    expect(errors.map((e) => e.property)).toEqual(['enabled']);
  });
});
