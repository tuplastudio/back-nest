import { Inject, Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { AuthenticationException, AuthorizationException } from '../common/errors/app.exception';
import { verifyGoogleIdToken, type JwksSource } from './google-id-token';

/** Injection token for Google's JWKS, so a test can sign with its own keys. */
export const GOOGLE_JWKS = Symbol('GoogleJwks');

/**
 * Authenticates the caller of an internal route (`POST /internal/tick`,
 * BN-TASK-016): a Google OIDC ID token for `INTERNAL_TICK_SA_EMAIL`, minted for
 * `INTERNAL_TICK_AUDIENCE` (the service URL; `PUBLIC_BASE_URL` by default).
 *
 *  * no configuration, no token, or a token that does not verify (signature,
 *    issuer, audience, expiry) → **401** `UNAUTHENTICATED`;
 *  * a valid Google token of another identity → **403** `FORBIDDEN`.
 *
 * The reason is logged, never returned.
 */
@Injectable()
export class InternalInvokerGuard implements CanActivate {
  private readonly logger = new Logger(InternalInvokerGuard.name);

  constructor(
    private readonly config: AppConfig,
    @Inject(GOOGLE_JWKS) private readonly jwks: JwksSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { serviceAccountEmail, audience } = this.config.internalTick;
    if (serviceAccountEmail === null || audience === null) {
      this.logger.warn('Internal call refused: INTERNAL_TICK_SA_EMAIL or its audience is not configured.');
      throw new AuthenticationException('Authentication required.');
    }
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const header = request?.headers?.['authorization'];
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (match === null) {
      throw new AuthenticationException('Authentication required.');
    }
    const verdict = await verifyGoogleIdToken(match[1], { audience, email: serviceAccountEmail }, this.jwks);
    if (verdict.ok) {
      return true;
    }
    this.logger.warn(`Internal call refused: ${verdict.reason}.`);
    if (verdict.reason === 'email') {
      throw new AuthorizationException('This identity may not call internal routes.');
    }
    throw new AuthenticationException('Authentication required.');
  }
}
