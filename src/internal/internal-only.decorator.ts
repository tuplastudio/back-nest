import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { INTERNAL_ROUTE_KEY } from '../common/decorators/internal-route.decorator';
import { DeclaredRbac } from '../common/decorators/roles.decorator';
import { InternalInvokerGuard } from './internal-invoker.guard';

/**
 * Declares a route internal (BN-TASK-016): called by the platform (Cloud
 * Scheduler), authenticated by {@link InternalInvokerGuard} with a Google OIDC ID
 * token, outside the tenant and principal model.
 *
 * The three parts travel together so none can be forgotten:
 *
 *  * `INTERNAL_ROUTE_KEY` — `AuthGuard` steps aside (the bearer is not an API key
 *    or a session) and the throttlers skip the route;
 *  * `DeclaredRbac()` — the boot-time RBAC audit counts the policy as declared;
 *  * `UseGuards(InternalInvokerGuard)` — the route's own authentication, which the
 *    audit requires of every internal route.
 *
 * @returns A method decorator.
 */
export const InternalOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(INTERNAL_ROUTE_KEY, true), DeclaredRbac(), UseGuards(InternalInvokerGuard));
