import 'express';
import type { RequestContextService } from '../tenancy/request-context.service';

/**
 * Module augmentation adding the correlation id assigned by
 * `RequestContextMiddleware` to Express's `Request`.
 *
 * Declaring it here rather than casting at each use site keeps guards,
 * interceptors and the exception filter reading `request.id` without repeating
 * an unsafe cast.
 */
declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Correlation id for the current request.
     *
     * Set by `RequestContextMiddleware`, echoed in the `X-Request-Id` response
     * header and written to the audit trail. When a client supplies
     * `X-Request-Id` and it passes validation, that value is reused so a trace
     * survives across services.
     */
    id?: string;

    /**
     * Request-scoped context holder.
     *
     * Attached by `RequestContextMiddleware` so parameter decorators can reach
     * the resolved tenant and principal without a service lookup. Nest parameter
     * decorators receive only the execution context, so this is the supported way
     * to hand a request-scoped service to them.
     */
    contextRef?: RequestContextService;
  }
}

export {};
