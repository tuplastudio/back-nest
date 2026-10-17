import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EMPTY_REQUEST_CONTEXT, RequestContext } from './tenant-context.interface';

/**
 * Request-scoped holder for {@link RequestContext}.
 *
 * A middleware opens a context per incoming request and every downstream
 * service (guards, interceptors, controllers, the tenant Prisma service) reads
 * it without having to thread parameters through every call. Because Node's
 * `AsyncLocalStorage` survives `await` boundaries, the value is correct even in
 * deeply nested async code and concurrent requests stay isolated from one
 * another.
 *
 * The class is deliberately a **singleton**, not request scoped. Nest would
 * create one instance per request, and each instance would own its own
 * `AsyncLocalStorage`, so a guard reading the context would see a different
 * store from the middleware that populated it. A single `AsyncLocalStorage`
 * already isolates concurrent requests, which is the entire point of the API.
 */
@Injectable()
export class RequestContextService {
  /** Shared across the whole process; `run()` scopes values per request. */
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  /**
   * Runs `callback` with an active request context.
   *
   * @param context Initial context values.
   * @param callback Work to perform inside the context.
   * @returns Whatever `callback` returns.
   */
  run<T>(context: Partial<RequestContext>, callback: () => T): T {
    return this.storage.run({ ...EMPTY_REQUEST_CONTEXT, ...context }, callback);
  }

  /**
   * Returns the active context, or an empty context outside a request.
   *
   * @returns The current context snapshot.
   */
  get(): RequestContext {
    return this.storage.getStore() ?? EMPTY_REQUEST_CONTEXT;
  }

  /**
   * Merges values into the active context.
   *
   * The existing store object is **mutated in place** rather than replaced with
   * `enterWith()`. `AsyncLocalStorage.enterWith` only rebinds the current
   * execution context and its future descendants, so a guard that patched the
   * context would not be visible to the *next* guard, which runs in a sibling
   * async resource. Mutating the store is visible to every holder of the same
   * reference, which is exactly the intended semantics.
   *
   * @param patch Fields to override, typically set by a guard.
   * @throws {Error} When called outside an active context.
   */
  patch(patch: Partial<RequestContext>): void {
    const current = this.storage.getStore();
    if (!current) {
      throw new Error('RequestContextService.patch() called outside of a request context.');
    }
    Object.assign(current, patch);
  }

  /**
   * Returns the resolved tenant.
   *
   * @returns The tenant context, or `null` when the request is not tenant scoped.
   */
  get tenant() {
    return this.get().tenant;
  }

  /**
   * Returns the authenticated principal.
   *
   * @returns The principal, or `null` when the request is unauthenticated.
   */
  get principal() {
    return this.get().principal;
  }

  /**
   * Returns the tenant or throws.
   *
   * Use in code paths that are only reachable behind `TenantGuard`.
   *
   * @returns The tenant context.
   * @throws {Error} When no tenant has been resolved.
   */
  requireTenant() {
    const tenant = this.get().tenant;
    if (!tenant) {
      throw new Error('No tenant resolved for this request; TenantGuard is missing on the route.');
    }
    return tenant;
  }

  /**
   * Returns the principal or throws.
   *
   * @returns The authenticated principal.
   * @throws {Error} When no principal has been attached.
   */
  requirePrincipal() {
    const principal = this.get().principal;
    if (!principal) {
      throw new Error('No principal attached to this request; an auth guard is missing on the route.');
    }
    return principal;
  }
}
