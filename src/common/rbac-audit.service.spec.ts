import 'reflect-metadata';
import { MetadataScanner, Reflector, type DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { RbacAuditService } from './rbac-audit.service';
import { ApiKeyOnly, Roles } from './decorators/roles.decorator';
import { Public } from './decorators/public.decorator';
import { MinimumPlatformRole, MinimumTenantRole } from './decorators/tenant-role.decorator';
import { RequireAllPermissions, RequirePermissions } from './decorators/permissions.decorator';
import { MemberRole } from '../generated/tenant-plane/enums';

/** HTTP verb codes Nest assigns to `@Get`, `@Post`, … . */
const GET = 0;
const POST = 1;

/**
 * Registers a route handler on a controller class.
 *
 * Nest's `SetMetadata` stores handler metadata on the handler *function* when a
 * descriptor is supplied, and the Reflector reads it from there — so this helper
 * writes to the function rather than to the prototype under the method name,
 * matching what the framework actually does.
 *
 * @param proto Controller prototype.
 * @param method Handler name.
 * @param path Route path.
 * @param verb HTTP verb metadata.
 */
function route(proto: object, method: string, path: string, verb: number = GET): void {
  const handler: unknown = (proto as Record<string, unknown>)[method];
  if (typeof handler !== 'function') {
    throw new Error(`no handler named ${method}`);
  }
  Reflect.defineMetadata('path', path, handler);
  Reflect.defineMetadata('method', verb, handler);
}

/**
 * Builds an audit service over the given controller classes.
 *
 * @param controllers Controller classes to audit.
 * @returns The audit service.
 */
function auditOf(...controllers: unknown[]): RbacAuditService {
  const providers = controllers.map((metatype) => ({ metatype, instance: {} }) as unknown as InstanceWrapper);
  const discovery = {
    getProviders: (): InstanceWrapper[] => providers,
  } as unknown as DiscoveryService;
  return new RbacAuditService(discovery, new MetadataScanner(), new Reflector());
}

describe('RbacAuditService', () => {
  it('reports a controller whose route declares no policy', () => {
    class UnguardedController {
      list(this: void): void {}
    }
    route(UnguardedController.prototype, 'list', 'items');
    Reflect.defineMetadata('path', 'unprotected', UnguardedController);
    Reflect.defineMetadata('__controller__', true, UnguardedController);

    const violations = auditOf(UnguardedController).findUndeclaredRoutes();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('UnguardedController.list');
    expect(violations[0]).toContain('GET /unprotected/items');
  });

  it('refuses to start and names the offending route', () => {
    class BrokenController {
      create(this: void): void {}
    }
    route(BrokenController.prototype, 'create', 'things', POST);
    Reflect.defineMetadata('path', 'broken', BrokenController);
    Reflect.defineMetadata('__controller__', true, BrokenController);

    const service = auditOf(BrokenController);
    expect(() => service.onApplicationBootstrap()).toThrow(/declare no authorization policy/);
    expect(() => service.onApplicationBootstrap()).toThrow(/BrokenController.create/);
    expect(() => service.onApplicationBootstrap()).toThrow(/POST \/broken\/things/);
  });

  it('accepts a route guarded by @Roles', () => {
    class PlatformController {
      list(this: void): void {}
    }
    route(PlatformController.prototype, 'list', 'items');
    (Roles('OWNER', 'ADMIN') as MethodDecorator)(PlatformController.prototype, 'list', {
      value: PlatformController.prototype.list,
    } as PropertyDescriptor);
    Reflect.defineMetadata('path', 'platform', PlatformController);
    Reflect.defineMetadata('__controller__', true, PlatformController);

    expect(auditOf(PlatformController).findUndeclaredRoutes()).toEqual([]);
  });

  it('accepts a route guarded by @RequirePermissions', () => {
    class PermissionController {
      issue(this: void): void {}
    }
    route(PermissionController.prototype, 'issue', 'keys', POST);
    (RequirePermissions('api-keys:issue') as MethodDecorator)(PermissionController.prototype, 'issue', {
      value: PermissionController.prototype.issue,
    } as PropertyDescriptor);
    Reflect.defineMetadata('path', 'permissions', PermissionController);
    Reflect.defineMetadata('__controller__', true, PermissionController);

    expect(auditOf(PermissionController).findUndeclaredRoutes()).toEqual([]);
  });

  it('accepts a route guarded by all-of permissions', () => {
    class StrictController {
      purge(this: void): void {}
    }
    route(StrictController.prototype, 'purge', 'tenants', POST);
    (RequireAllPermissions('tenants:read', 'tenants:purge') as MethodDecorator)(
      StrictController.prototype,
      'purge',
      { value: StrictController.prototype.purge } as PropertyDescriptor,
    );
    Reflect.defineMetadata('path', 'strict', StrictController);
    Reflect.defineMetadata('__controller__', true, StrictController);

    expect(auditOf(StrictController).findUndeclaredRoutes()).toEqual([]);
  });

  it('accepts a public route and an API-key-only route', () => {
    class OpenController {
      signIn(this: void): void {}
      callback(this: void): void {}
    }
    route(OpenController.prototype, 'signIn', 'sign-in', POST);
    (Public() as MethodDecorator)(OpenController.prototype, 'signIn', {
      value: OpenController.prototype.signIn,
    } as PropertyDescriptor);
    route(OpenController.prototype, 'callback', 'callback', POST);
    (ApiKeyOnly() as MethodDecorator)(OpenController.prototype, 'callback', {
      value: OpenController.prototype.callback,
    } as PropertyDescriptor);
    Reflect.defineMetadata('path', 'auth', OpenController);
    Reflect.defineMetadata('__controller__', true, OpenController);

    expect(auditOf(OpenController).findUndeclaredRoutes()).toEqual([]);
  });

  it('accepts a dual-plane route declared only at the class level', () => {
    class KeysController {
      issue(this: void): void {}
      list(this: void): void {}
    }
    route(KeysController.prototype, 'issue', '', POST);
    route(KeysController.prototype, 'list', '');
    (MinimumTenantRole(MemberRole.ADMIN) as ClassDecorator)(KeysController);
    (MinimumPlatformRole('ADMIN') as ClassDecorator)(KeysController);
    Reflect.defineMetadata('path', 'api-keys', KeysController);
    Reflect.defineMetadata('__controller__', true, KeysController);

    expect(auditOf(KeysController).findUndeclaredRoutes()).toEqual([]);
  });

  it('reports every offending route, not just the first', () => {
    class ManyController {
      one(this: void): void {}
      two(this: void): void {}
    }
    route(ManyController.prototype, 'one', 'one');
    route(ManyController.prototype, 'two', 'two');
    Reflect.defineMetadata('path', 'many', ManyController);
    Reflect.defineMetadata('__controller__', true, ManyController);

    expect(auditOf(ManyController).findUndeclaredRoutes()).toHaveLength(2);
  });

  it('describes the policy each route declares', () => {
    class KeysController {
      issue(this: void): void {}
    }
    route(KeysController.prototype, 'issue', '', POST);
    (RequirePermissions('api-keys:issue') as MethodDecorator)(KeysController.prototype, 'issue', {
      value: KeysController.prototype.issue,
    } as PropertyDescriptor);
    (MinimumPlatformRole('ADMIN') as ClassDecorator)(KeysController);
    Reflect.defineMetadata('path', 'api-keys', KeysController);
    Reflect.defineMetadata('__controller__', true, KeysController);

    const lines = auditOf(KeysController).describePolicies();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('api-keys:issue');
    expect(lines[0]).toContain('platform role >= ADMIN');
    expect(lines[0]).not.toContain('NONE');
  });

  it('ignores providers that are not controllers', () => {
    class SomeService {
      doThing(): void {}
    }
    Reflect.defineMetadata('path', 'not-a-route', SomeService.prototype, 'doThing');
    const service = auditOf(SomeService);
    expect(service.findUndeclaredRoutes()).toEqual([]);
    expect(service.describePolicies()).toEqual([]);
  });
});
