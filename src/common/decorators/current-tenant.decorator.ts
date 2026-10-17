import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { type RequestContextService } from '../../tenancy/request-context.service';
import type { Principal, RequestContext, TenantContext } from '../../tenancy/tenant-context.interface';

/**
 * Express request augmented with the correlation id assigned by middleware.
 *
 * The augmentation itself is declared in `src/types/express.d.ts`.
 */
export type CorrelatedRequest = Request & { id?: string };

/**
 * Reads the request context from the HTTP execution context.
 *
 * The context service is attached to the request by
 * `RequestContextMiddleware`; going through the request (rather than a global
 * lookup) keeps this working under both HTTP and non-HTTP transports.
 *
 * @param context Execution context.
 * @returns The request-scoped context holder.
 */
function contextOf(context: ExecutionContext): RequestContextService {
  const request = context.switchToHttp().getRequest<{ contextRef?: RequestContextService }>();
  if (!request.contextRef) {
    throw new Error(
      'RequestContextMiddleware did not run for this route. Ensure TenancyModule is imported by AppModule.',
    );
  }
  return request.contextRef;
}

/**
 * Injects the resolved {@link TenantContext}.
 *
 * ```ts
 * findAll(@CurrentTenant() tenant: TenantContext) {}
 * ```
 *
 * @throws When no tenant has been resolved for the request.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => contextOf(context).requireTenant(),
);

/**
 * Injects the resolved tenant, or `null` on platform-level routes.
 *
 * Useful for endpoints that behave differently depending on whether a tenant was
 * specified, such as audit log queries.
 */
export const OptionalTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext | null => contextOf(context).tenant,
);

/**
 * Injects the authenticated {@link Principal}.
 *
 * @throws When no principal has been attached by a guard.
 */
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal =>
  contextOf(context).requirePrincipal(),
);

/**
 * Injects the full {@link RequestContext}.
 */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): RequestContext =>
  contextOf(context).get(),
);

/**
 * Injects the client IP address as reported by Express.
 *
 * Accurate only when `TRUST_PROXY_HOPS` matches the number of proxies in front of
 * the application; otherwise the value is the proxy's address.
 */
export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<CorrelatedRequest>();
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
});

/**
 * Injects the correlation id assigned to the request.
 */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    contextOf(context).get().requestId || (context.switchToHttp().getRequest<CorrelatedRequest>().id ?? ''),
);

/**
 * Convenience helper for seeding a context outside the HTTP pipeline, e.g. when
 * a queue consumer needs to act on behalf of a tenant.
 *
 * @param context Values to seed.
 * @returns A complete context object.
 */
export function seedContext(context: Partial<RequestContext>): RequestContext {
  return {
    tenant: null,
    principal: null,
    requestId: '',
    ipHash: null,
    userAgentHash: null,
    ...context,
  };
}
