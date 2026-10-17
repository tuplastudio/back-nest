import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { CONTROLLER_WATERMARK, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { API_KEY_ONLY_KEY, ROLES_KEY, isRbacDeclared } from './decorators/roles.decorator';
import { isPublic } from './decorators/public.decorator';
import { MINIMUM_PLATFORM_ROLE, MINIMUM_TENANT_ROLE } from './decorators/tenant-role.decorator';
import { ALL_PERMISSIONS_KEY, PERMISSIONS_KEY } from './decorators/permissions.decorator';

/**
 * A Reflector target: a controller class or a route handler.
 *
 * Spelled as a call/construct signature rather than `Function`, which the lint
 * rules ban precisely because it accepts anything callable.
 */
type MetadataTarget = ((...args: never[]) => unknown) | (new (...args: never[]) => unknown);

const METHOD_LABEL: Readonly<Record<number, string>> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
  5: 'ALL',
  6: 'OPTIONS',
  7: 'HEAD',
  8: 'SEARCH',
};

/**
 * Joins a controller path and a handler path into a readable route.
 *
 * Nest stores the segments without slashes (`@Controller('api-keys')` plus
 * `@Get(':id')`), so the audit normalises them for the error message.
 *
 * @param controllerPath Controller-level path segment.
 * @param methodPath Handler-level path segment.
 * @returns A route such as `/api-keys/:id`.
 */
function joinPath(controllerPath: string, methodPath: string): string {
  const parts = [controllerPath, methodPath]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}

/** One route found while auditing. */
interface RouteEntry {
  readonly description: string;
  readonly declared: boolean;
}

/**
 * Verifies at boot that every reachable route declares an authorization policy.
 *
 * Authentication is deny-by-default because `AuthGuard` is registered as an
 * `APP_GUARD`, so a new controller cannot ship unauthenticated. Authorization had
 * no equivalent structural guarantee: it was opt-in through route metadata, so a
 * controller that simply omitted a role decorator was treated as unrestricted.
 * That is not hypothetical — it is how the read-only platform `AUDITOR` role
 * reached the tenant credential lifecycle in `ApiKeysController`, the only
 * control-plane controller that mutates state without declaring a platform
 * requirement.
 *
 * This service closes that class of regression by turning it into a startup
 * failure. It walks the controller route table once, on bootstrap, and throws
 * when a route is neither public nor API-key-only and carries no
 * `RBAC_DECLARED_KEY` marker. The error names every offending route, so the fix
 * is always obvious.
 */
@Injectable()
export class RbacAuditService implements OnApplicationBootstrap {
  /**
   * Reads metadata across handler and controller, handler first.
   *
   * Bound in the constructor so the `Reflector` instance is captured and the
   * `any` its untyped overloads return is narrowed to `unknown` in one place,
   * rather than at each of the call sites below.
   */
  private readonly readMetadata: (key: string, targets: MetadataTarget[]) => unknown;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    reflector: Reflector,
  ) {
    this.readMetadata = (key, targets) => reflector.getAllAndOverride<unknown>(key, targets);
  }

  onApplicationBootstrap(): void {
    const violations = this.routes().filter((r) => !r.declared);
    if (violations.length === 0) {
      return;
    }
    throw new Error(
      'RBAC policy audit failed: the following routes declare no authorization policy.\n' +
        'Authorization is deny-by-default: every non-public route must state who may call it.\n' +
        `${violations.map((v) => `  - ${v.description}`).join('\n')}\n` +
        'Fix each with @Roles(...) for a platform-only route, ' +
        '@MinimumTenantRole(...) and/or @MinimumPlatformRole(...) for a route that admits both planes, ' +
        '@RequirePermissions(...) for fine-grained RBAC permissions, ' +
        'or @Public() / @ApiKeyOnly() if it really is unrestricted.',
    );
  }

  /**
   * Lists every route that reaches a handler without declaring a policy.
   *
   * @returns Human-readable route descriptions, empty when the audit passes.
   */
  findUndeclaredRoutes(): string[] {
    return this.routes()
      .filter((r) => !r.declared)
      .map((r) => r.description);
  }

  /**
   * Summarises the declared policy of every route, for operator review.
   *
   * @returns One line per route describing the authorization it declares.
   */
  describePolicies(): string[] {
    return this.walk().map(({ controller, handler, path, label }) => {
      const parts: string[] = [];
      const roles = this.meta<string[]>(ROLES_KEY, [handler, controller]);
      if (roles?.length) {
        parts.push(`platform roles: ${roles.join('|')}`);
      }
      const tenant = this.meta<string>(MINIMUM_TENANT_ROLE, [handler, controller]);
      if (tenant !== undefined) {
        parts.push(`tenant role >= ${tenant}`);
      }
      const platform = this.meta<string>(MINIMUM_PLATFORM_ROLE, [handler, controller]);
      if (platform !== undefined) {
        parts.push(`platform role >= ${platform}`);
      }
      const anyOf = this.meta<string[]>(PERMISSIONS_KEY, [handler, controller]);
      if (anyOf?.length) {
        parts.push(`any of: ${anyOf.join('|')}`);
      }
      const allOf = this.meta<string[]>(ALL_PERMISSIONS_KEY, [handler, controller]);
      if (allOf?.length) {
        parts.push(`all of: ${allOf.join('+')}`);
      }
      if (isPublic(handler) || isPublic(controller)) {
        parts.push('public');
      }
      const name = (controller as { name?: string }).name ?? 'Controller';
      return `${name}.${String(label)} ${path} -> ${parts.join('; ') || 'NONE'}`;
    });
  }

  /**
   * Walks the controller route table once.
   *
   * @returns Every route with whether it declares an authorization policy.
   */
  private routes(): RouteEntry[] {
    return this.walk().map(({ controller, handler, path, label }) => {
      const declared =
        isRbacDeclared(handler) ||
        isRbacDeclared(controller) ||
        this.meta<boolean>(API_KEY_ONLY_KEY, [handler]) === true ||
        this.meta<boolean>(API_KEY_ONLY_KEY, [controller]) === true ||
        isPublic(handler) ||
        isPublic(controller);
      const name = (controller as { name?: string }).name ?? 'Controller';
      return { description: `${name}.${label} ${path}`, declared };
    });
  }

  /** A single route discovered in the controller route table. */
  private walk(): {
    controller: MetadataTarget;
    handler: MetadataTarget;
    path: string;
    label: string;
  }[] {
    const found: {
      controller: MetadataTarget;
      handler: MetadataTarget;
      path: string;
      label: string;
    }[] = [];

    for (const wrapper of this.discovery.getProviders()) {
      if (!wrapper.instance) {
        continue;
      }
      const controller = this.controllerOf(wrapper.metatype);
      if (controller === null) {
        continue;
      }
      const controllerPath = this.meta<string>(PATH_METADATA, [controller]) ?? '';
      const proto = controller.prototype as Record<string, unknown>;

      for (const methodName of this.metadataScanner.getAllMethodNames(proto)) {
        const raw: unknown = proto[methodName];
        if (typeof raw !== 'function') {
          continue;
        }
        const handler = raw as MetadataTarget;
        const methodPath = this.meta<string>(PATH_METADATA, [handler]);
        if (methodPath === undefined) {
          continue; // not a route handler
        }
        const requestMethod = this.meta<number>(METHOD_METADATA, [handler]);
        const label = METHOD_LABEL[requestMethod ?? 0] ?? 'GET';
        found.push({
          controller,
          handler,
          path: joinPath(controllerPath, methodPath),
          label: `${methodName} ${label}`,
        });
      }
    }
    return found;
  }

  /**
   * Narrows a discovered provider to a controller class.
   *
   * @param metatype Provider metatype as reported by discovery.
   * @returns The controller class, or `null` when it is not a controller.
   */
  private controllerOf(metatype: unknown): MetadataTarget | null {
    if (typeof metatype !== 'function') {
      return null;
    }
    if (Reflect.getMetadata(CONTROLLER_WATERMARK, metatype) !== true) {
      return null;
    }
    return metatype as MetadataTarget;
  }

  /**
   * Reads route metadata with an explicit result type.
   *
   * `Reflector.getAllAndOverride` returns `any` for untyped keys, which the lint
   * rules reject at every call site; the narrowing is expressed once here.
   *
   * @param key Metadata key to read.
   * @param targets Handler and controller, in precedence order.
   * @returns The declared metadata value, or `undefined`.
   */
  private meta<T>(key: string, targets: MetadataTarget[]): T | undefined {
    const value = this.readMetadata(key, targets);
    return value === undefined ? undefined : (value as T);
  }
}
