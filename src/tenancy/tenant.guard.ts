import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { TenantStatus } from '../generated/control-plane/enums';
import { RequestContextService } from './request-context.service';
import { TenantRequiredException, TenantUnavailableException } from '../common/errors/app.exception';

/**
 * Ensures a request is scoped to a tenant that may serve traffic.
 *
 * Applied to every tenant-facing controller. It distinguishes two failure modes
 * that a controller should not have to:
 *
 *  * **No tenant** — the request carried no `X-Tenant-Id`, no `X-Tenant-Slug` and
 *    no tenant subdomain. Answered with 400, because retrying with different
 *    data could succeed and the caller most likely has a routing bug.
 *  * **Tenant present but unusable** — provisioning, suspension, deprecation or
 *    deletion. Answered with 403 and the current status, because retrying will
 *    not help until an operator intervenes.
 *
 * Applying this guard is what makes
 * {@link TenantPrismaService.forCurrentTenant} safe: a handler that reads the
 * current tenant is guaranteed to have passed this check first.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  /**
   * @param requestContext Request-scoped context holder.
   */
  constructor(private readonly requestContext: RequestContextService) {}

  /**
   * @param _context Execution context; the decision uses the request context.
   * @returns `true` when an active tenant is available.
   * @throws {TenantRequiredException} When no tenant was resolved.
   * @throws {TenantUnavailableException} When the tenant is not `ACTIVE`.
   */
  canActivate(_context: ExecutionContext): boolean {
    const tenant = this.requestContext.tenant;

    if (!tenant) {
      throw new TenantRequiredException();
    }
    if (tenant.status !== TenantStatus.ACTIVE) {
      throw new TenantUnavailableException(tenant.slug, tenant.status);
    }
    return true;
  }
}
