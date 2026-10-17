import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppConfig } from '../config/app-config.service';
import { PiiCryptoService } from '../pii/pii-crypto.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';

/** Header carrying a client-supplied or generated correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Correlation ids accepted from clients must be short and opaque; accepting
 * arbitrary text would let a caller inject control characters into logs.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Opens a request context and resolves the tenant before any guard runs.
 *
 * Runs for every route. Responsibilities:
 *  1. establish (or adopt) a correlation id,
 *  2. open the `AsyncLocalStorage` request context,
 *  3. hash the client IP and user agent once, so guards and services do not
 *     re-hash them,
 *  4. resolve the tenant from headers or subdomain and store it in the context,
 *  5. echo the correlation id in the `X-Request-Id` response header.
 *
 * Tenant resolution failures are deliberately *not* fatal here. A missing
 * tenant is a legitimate state for platform-level routes (`/tenants`,
 * `/auth/sign-in`), so `TenantGuard` decides whether the route requires one.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  /**
   * @param requestContext Request-scoped context holder.
   * @param tenants Tenant resolver.
   * @param crypto PII crypto service for hashing the client IP.
   * @param config Validated application configuration.
   */
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly tenants: TenantResolverService,
    private readonly crypto: PiiCryptoService,
    private readonly config: AppConfig,
  ) {}

  /**
   * @param request Incoming request.
   * @param response Outgoing response.
   * @param next Next middleware in the chain.
   */
  use(request: Request, response: Response, next: NextFunction): void {
    // Parameter decorators only receive the execution context, so the
    // request-scoped service is attached to the request for them to reach.
    request.contextRef = this.requestContext;

    const requestId = this.resolveRequestId(request);
    request.id = requestId;
    response.setHeader('X-Request-Id', requestId);

    // Hash once, reuse everywhere: the raw IP never needs to travel further.
    const ipHash = this.crypto.hashIp(request.ip ?? request.socket.remoteAddress ?? null);
    // `request.get()` is used instead of indexing `request.headers`: it returns a
    // properly typed `string | undefined`, whereas the header index signature is
    // `any`.
    const userAgentHash = this.tenants.hashUserAgent(request.get('user-agent'));

    // The context callback is intentionally async: tenant resolution happens
    // inside it so that everything downstream sees a populated context.
    void this.requestContext.run({ requestId, ipHash, userAgentHash }, async () => {
      try {
        await this.tenants.resolveForRequest(request.headers);
      } catch (error) {
        // A resolver failure must not mask the original request, but it must be
        // visible: falling back to a tenant-less context would be a security
        // downgrade if the route actually needed one.
        this.logger.error(
          `Tenant resolution failed for [${requestId}]: ${(error as Error).message}. ` +
            'The request continues without a tenant.',
        );
      }
      next();
    });
  }

  /**
   * Adopts a client-supplied correlation id when it is well formed, otherwise
   * generates a new one.
   *
   * @param request Incoming request.
   * @returns The correlation id to use.
   */
  private resolveRequestId(request: Request): string {
    const supplied = request.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    if (candidate && REQUEST_ID_PATTERN.test(candidate)) {
      return candidate;
    }
    if (candidate) {
      this.logger.warn('Discarded malformed X-Request-Id header; generated a new correlation id.');
    }

    // A random UUID is correlation-safe. When the API sits behind a gateway that
    // already hashed PII out of the path, the id stays opaque either way.
    return (
      randomUUID().replaceAll('-', '').slice(0, 24) +
      createHash('sha1').update(randomUUID()).digest('hex').slice(0, 8)
    );
  }

  /** Exposes the base domain so other services can build tenant URLs. */
  get apiBaseDomain(): string {
    return this.config.apiBaseDomain;
  }
}
