import 'reflect-metadata';
import { jest } from '@jest/globals';
import { MetadataScanner, Reflector, type DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { RbacAuditService } from './rbac-audit.service';
import { SCOPES_KEY } from './decorators/scopes.decorator';
import { PERMISSIONS_KEY } from './decorators/permissions.decorator';

// `@nestjs/throttler` is CommonJS that `require`s the ESM-only `@nestjs/common`,
// which Jest's VM-modules runtime cannot load on Node 22. Its decorators carry
// no authorization metadata, so they are replaced with no-ops here.
const noopDecorator = (): MethodDecorator & ClassDecorator => () => undefined;
jest.unstable_mockModule('@nestjs/throttler', () => ({
  Throttle: noopDecorator,
  SkipThrottle: noopDecorator,
  ThrottlerGuard: class {},
  ThrottlerModule: class {},
  ThrottlerStorage: Symbol('ThrottlerStorage'),
}));

type Ctor = abstract new (...args: never[]) => unknown;
let GRANTABLE_SCOPES: readonly string[] = [];
let TenantUsersController: Ctor;
let OutboundWebhookController: Ctor;
let InternalController: Ctor;
let CONTROLLERS: Ctor[] = [];

beforeAll(async () => {
  // Sequential on purpose: Jest's ESM loader races on shared dependencies
  // (`reflect-metadata`) when several graphs are linked concurrently.
  const apiKeys = await import('../api-keys/api-keys.controller.js');
  const apiKeyService = await import('../api-keys/api-key.service.js');
  const auth = await import('../auth/auth.controller.js');
  const health = await import('../health/health.controller.js');
  const netpay = await import('../payments/netpay-webhook.controller.js');
  const outbound = await import('../payments/outbound/outbound-webhook.controller.js');
  const orders = await import('../payments/payment-orders.controller.js');
  const tenants = await import('../tenancy/tenants.controller.js');
  const tenantApi = await import('../tenant-api/tenant-api.controller.js');
  const internal = await import('../internal/internal.controller.js');
  GRANTABLE_SCOPES = apiKeyService.GRANTABLE_SCOPES;
  TenantUsersController = tenantApi.TenantUsersController;
  OutboundWebhookController = outbound.OutboundWebhookController;
  InternalController = internal.InternalController;
  CONTROLLERS = [
    internal.InternalController,
    apiKeys.ApiKeysController,
    auth.AuthController,
    health.HealthController,
    netpay.NetpayWebhookController,
    outbound.OutboundWebhookController,
    orders.PaymentOrdersController,
    tenants.TenantsController,
    tenantApi.TenantAuthController,
    tenantApi.TenantProjectsController,
    tenantApi.TenantUsersController,
  ];
});

/**
 * Runs the boot-time audit over the application's real controllers.
 *
 * The unit tests in `rbac-audit.service.spec.ts` prove the rule; this proves the
 * shipped route table satisfies it, so a regression fails here before it fails a
 * deployment's boot.
 */
function audit(): RbacAuditService {
  const providers = CONTROLLERS.map((metatype) => ({ metatype, instance: {} }) as unknown as InstanceWrapper);
  // Nest lists controllers separately from providers; the audit must read both.
  const discovery = {
    getProviders: (): InstanceWrapper[] => [],
    getControllers: (): InstanceWrapper[] => providers,
  } as unknown as DiscoveryService;
  return new RbacAuditService(discovery, new MetadataScanner(), new Reflector());
}

describe('RBAC route table (BN-REQ-SEC-001)', () => {
  it('has no route with @RequirePermissions and no @RequireScopes', () => {
    expect(audit().findUnscopedPermissionRoutes()).toEqual([]);
  });

  it('boots: every route declares a policy and a scope where it declares permissions', () => {
    expect(() => audit().onApplicationBootstrap()).not.toThrow();
  });

  it('declares POST /internal/tick as an internal route with the OIDC guard (BN-TASK-016)', () => {
    const tick = (InternalController.prototype as unknown as Record<string, object>)['tick'];
    expect(Reflect.getMetadata('auth:internal', tick)).toBe(true);
    const guards = (Reflect.getMetadata('__guards__', tick) as { name: string }[] | undefined) ?? [];
    expect(guards.map((g) => g.name)).toContain('InternalInvokerGuard');
    expect(audit().describePolicies()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/InternalController\.tick POST \/internal\/tick -> .*internal/),
      ]),
    );
  });

  it('makes webhooks:read and webhooks:write grantable to API keys', () => {
    expect(GRANTABLE_SCOPES).toEqual(expect.arrayContaining(['webhooks:read', 'webhooks:write']));
  });

  it('requires a webhooks scope on every /t/webhooks route', () => {
    const proto = OutboundWebhookController.prototype as unknown as Record<string, unknown>;
    const handlers = new MetadataScanner()
      .getAllMethodNames(proto)
      .map((name) => proto[name])
      .filter(
        (fn): fn is object => typeof fn === 'function' && Reflect.getMetadata('path', fn) !== undefined,
      );
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      const scopes = Reflect.getMetadata(SCOPES_KEY, handler) as string[] | undefined;
      expect(scopes?.every((s) => s === 'webhooks:read' || s === 'webhooks:write')).toBe(true);
    }
  });

  it('requires users:write at method level on POST /t/users, so VIEWER is refused (BN-REQ-SEC-003)', () => {
    const create = (TenantUsersController.prototype as unknown as Record<string, object>)['create'];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, create)).toEqual(['users:write']);
    const list = (TenantUsersController.prototype as unknown as Record<string, object>)['list'];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, list)).toEqual(['users:read']);
  });
});
