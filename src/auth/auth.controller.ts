import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AppConfig } from '../config/app-config.service';
import { AdminAuthService, type SignInResult } from './admin-auth.service';
import {
  ChangePasswordDto,
  MfaCodeDto,
  MfaEnrollmentDto,
  RefreshTokenDto,
  SignInDto,
  TokenResponseDto,
} from './dto/sign-in.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthThrottle } from './throttling';
import { AdminMfaService, InvalidMfaCodeException } from './admin-mfa.service';
import { AllowMfaPending, AllowPasswordChangePending } from './admin-session-policy';
import type { AuthenticatedRequest } from './auth.guard';
import { AuthorizationException } from '../common/errors/app.exception';
import { RequestContextService } from '../tenancy/request-context.service';
import { TokenService } from './token.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';

/**
 * Name of the `HttpOnly` cookie carrying the refresh token.
 *
 * `HttpOnly` keeps the token out of reach of JavaScript, so an XSS bug cannot
 * exfiltrate it; `SameSite=Strict` prevents it from being sent on cross-site
 * requests; `Secure` is required in production behind TLS.
 */
export const REFRESH_COOKIE = 'mtb_rt';

/**
 * Platform administrator authentication endpoints.
 *
 * Rate limiting
 * -------------
 * `@AuthThrottle` applies the `auth` throttler, a per-IP budget far tighter than
 * the global default, to the credential endpoints only (BN-REQ-SEC-004). A
 * password endpoint without aggressive throttling is trivially brute-forceable
 * even with account lockout, because lockout only limits one account at a time.
 *
 * Token delivery
 * --------------
 * The refresh token is returned both in the body (for CLIs and services) and in
 * an `HttpOnly` cookie (for browser clients). Browsers should ignore the body
 * copy; it exists so non-browser callers have one contract.
 */
@ApiTags('authentication')
@Controller('auth')
export class AuthController {
  /**
   * @param auth Administrator authentication service.
   * @param requestContext Request-scoped context holder, for audit metadata.
   * @param config Validated application configuration.
   */
  constructor(
    private readonly auth: AdminAuthService,
    private readonly requestContext: RequestContextService,
    private readonly prisma: ControlPlanePrismaService,
    private readonly config: AppConfig,
    private readonly mfa: AdminMfaService,
  ) {}

  /**
   * Signs a platform administrator in.
   *
   * @param body Credentials.
   * @param req Incoming request, for the audit trail.
   * @param res Outgoing response, used to set the refresh cookie.
   * @returns The issued token pair and profile summary.
   */
  @Public()
  @AuthThrottle()
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: SignInDto })
  @ApiOperation({
    summary: 'Sign in as a platform administrator',
    description: [
      'Exchanges an e-mail and password for an access token and a rotating refresh token.',
      '',
      'Failures are deliberately indistinguishable: an unknown e-mail, a wrong password',
      'and a locked account all return `INVALID_CREDENTIALS` after roughly the same',
      'amount of work, so the endpoint cannot be used to enumerate accounts.',
      '',
      'Repeated failures lock the account for `AUTH_LOCKOUT_DURATION`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: () => TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials, or the account is locked.' })
  async signIn(
    @Body() body: SignInDto,
    @Req() req: Request,
    @Req() _unused: Request,
  ): Promise<TokenResponseDto> {
    void _unused;
    const result = await this.auth.signIn(body.email, body.password, this.auditContext(req), body.otp);
    return this.toResponse(result, req, this.responseOf(req));
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * @param body Refresh token.
   * @param req Incoming request.
   * @returns The new token pair.
   */
  @Public()
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: RefreshTokenDto })
  @ApiOperation({
    summary: 'Refresh an administrator session',
    description: [
      'Rotates the refresh token. The presented token is revoked and marked as replaced.',
      '',
      'Presenting an already-rotated token means it leaked, so the entire rotation',
      'family is revoked and `TOKEN_REUSE_DETECTED` is returned.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: () => TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'The token is unknown, expired or already revoked.' })
  async refresh(@Body() body: RefreshTokenDto, @Req() req: Request): Promise<TokenResponseDto> {
    const result = await this.auth.refresh(body.refreshToken, this.auditContext(req));
    return this.toResponse(result, req, this.responseOf(req));
  }

  /**
   * Revokes the current session.
   *
   * Stateless access tokens remain valid until they expire; revoking the refresh
   * family stops the session from being extended.
   *
   * @param body Refresh token identifying the family to revoke.
   * @param req Incoming request.
   * @returns HTTP 204.
   */
  @Public()
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: RefreshTokenDto })
  @ApiOperation({
    summary: 'Sign out',
    description: 'Revokes the refresh token family associated with the presented token.',
  })
  @ApiOkResponse({ description: 'Session revoked.' })
  async signOut(@Body() body: RefreshTokenDto, @Req() req: Request): Promise<void> {
    const response = this.responseOf(req);
    response?.clearCookie(REFRESH_COOKIE, this.cookieOptions());

    if (body.refreshToken) {
      await this.revokeFamilyFor(body.refreshToken);
    }
  }

  /**
   * Reports whether the configured documentation credentials are correct.
   *
   * @returns `{ authenticated: false }` always; used by clients to detect that
   * credentials are required without a 401 round trip.
   */
  @Public()
  @AllowMfaPending()
  @AllowPasswordChangePending()
  @Get('session')
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({
    summary: 'Inspect the current session',
    description: 'Returns the principal attached to the request. Requires a valid access token.',
  })
  @ApiOkResponse({ description: 'The authenticated principal.' })
  session(): { principal: unknown; requestId: string } {
    return {
      principal: this.requestContext.principal,
      requestId: this.requestContext.get().requestId,
    };
  }

  /**
   * Starts TOTP enrolment (BN-REQ-SEC-006).
   *
   * @param req Incoming request.
   * @returns The shared secret and `otpauth://` URI, shown once.
   */
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @AllowMfaPending()
  @AllowPasswordChangePending()
  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({
    summary: 'Start TOTP enrolment',
    description: 'Returns a new secret; confirm it with a code.',
  })
  @ApiOkResponse({ type: () => MfaEnrollmentDto })
  enrollMfa(@Req() req: Request): Promise<MfaEnrollmentDto> {
    return this.mfa.enroll(this.adminIdOf(req));
  }

  /**
   * Confirms enrolment and returns recovery codes plus an MFA-verified session.
   *
   * @param body First TOTP code.
   * @param req Incoming request.
   * @returns Recovery codes (shown once) and a new session.
   */
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @AllowMfaPending()
  @AllowPasswordChangePending()
  @AuthThrottle()
  @Post('mfa/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({ summary: 'Confirm TOTP enrolment' })
  async confirmMfa(
    @Body() body: MfaCodeDto,
    @Req() req: Request,
  ): Promise<TokenResponseDto & { recoveryCodes: string[] }> {
    const adminId = this.adminIdOf(req);
    const { recoveryCodes } = await this.mfa.confirm(adminId, body.code);
    const session = await this.auth.issueSession(
      adminId,
      this.auditContext(req),
      Math.floor(Date.now() / 1000),
    );
    return { ...this.toResponse(session, req, this.responseOf(req)), recoveryCodes };
  }

  /**
   * Verifies a TOTP or recovery code and returns an MFA-verified session. Also
   * the step-up: a verification younger than 5 minutes unlocks payment writes.
   *
   * @param body Code.
   * @param req Incoming request.
   * @returns A new session carrying the verification time.
   */
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @AllowMfaPending()
  @AllowPasswordChangePending()
  @AuthThrottle()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({ summary: 'Verify a second factor (sign-in completion and step-up)' })
  @ApiOkResponse({ type: () => TokenResponseDto })
  async verifyMfa(@Body() body: MfaCodeDto, @Req() req: Request): Promise<TokenResponseDto> {
    const adminId = this.adminIdOf(req);
    if (!(await this.mfa.verify(adminId, body.code, this.auditContext(req)))) {
      throw new InvalidMfaCodeException();
    }
    const session = await this.auth.issueSession(
      adminId,
      this.auditContext(req),
      Math.floor(Date.now() / 1000),
    );
    return this.toResponse(session, req, this.responseOf(req));
  }

  /**
   * Replaces the recovery codes.
   *
   * @param body Current code.
   * @param req Incoming request.
   * @returns New recovery codes, shown once.
   */
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @AuthThrottle()
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({ summary: 'Regenerate MFA recovery codes' })
  regenerateRecoveryCodes(
    @Body() body: MfaCodeDto,
    @Req() req: Request,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.regenerateRecoveryCodes(this.adminIdOf(req), body.code);
  }

  /**
   * Disables MFA. When `MFA_REQUIRED_FOR_ADMINS` is on, the admin must enrol
   * again before using anything else.
   *
   * @param body Current code.
   * @param req Incoming request.
   */
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @AuthThrottle()
  @Post('mfa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({ summary: 'Disable the second factor' })
  async disableMfa(@Body() body: MfaCodeDto, @Req() req: Request): Promise<void> {
    await this.mfa.disable(this.adminIdOf(req), body.code);
  }

  /**
   * Changes the caller's password. The only endpoint reachable while
   * `mustChangePassword` is set (BN-REQ-SEC-008).
   *
   * @param body Current and new password.
   * @param req Incoming request.
   * @returns A new session; every other session is revoked.
   */
  @Roles('OWNER', 'ADMIN', 'AUDITOR')
  @AllowPasswordChangePending()
  @AuthThrottle()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer-jwt')
  @ApiOperation({ summary: 'Change the administrator password' })
  @ApiOkResponse({ type: () => TokenResponseDto })
  async changePassword(@Body() body: ChangePasswordDto, @Req() req: Request): Promise<TokenResponseDto> {
    const result = await this.auth.changePassword(
      this.adminIdOf(req),
      body.currentPassword,
      body.newPassword,
      this.auditContext(req),
      (req as Request & AuthenticatedRequest).adminMfaAt,
    );
    return this.toResponse(result, req, this.responseOf(req));
  }

  /**
   * Reads the authenticated platform admin's id.
   *
   * @param req Incoming request.
   * @returns Admin id.
   */
  private adminIdOf(req: Request): string {
    const principal = (req as Request & AuthenticatedRequest).principal ?? this.requestContext.principal;
    if (!principal || principal.kind !== 'platform-admin') {
      throw new AuthorizationException('Only platform administrators have a second factor here.');
    }
    return principal.id;
  }

  /**
   * Builds the response body from a sign-in result.
   *
   * @param result The sign-in result.
   * @param req Incoming request.
   * @param response Outgoing response, when available.
   * @returns The response DTO.
   */
  private toResponse(result: SignInResult, req: Request, response: Response | null): TokenResponseDto {
    response?.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions());

    void req;
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.max(0, Math.round((result.accessTokenExpiresAt - Date.now()) / 1000)),
      emailMasked: result.emailMasked,
      displayName: result.displayName,
      role: result.role,
      mustChangePassword: result.mustChangePassword,
      mfaRequired: result.mfaRequired,
    };
  }

  /**
   * Cookie attributes for the refresh token.
   *
   * @returns Options for `res.cookie`.
   */
  private cookieOptions(): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'strict' | 'lax';
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      // `Secure` is required in production; leaving it off over plain HTTP would
      // work locally but silently expose the token on any non-TLS connection.
      secure: !this.config.isDevelopment,
      sameSite: 'strict',
      path: '/',
      maxAge: this.config.jwtRefreshTtlMs,
    };
  }

  /**
   * Extracts the Express response attached to the request.
   *
   * @param req The request.
   * @returns The response, or `null` outside an HTTP context.
   */
  private responseOf(req: Request): Response | null {
    return (req as Request & { res?: Response }).res ?? null;
  }

  /**
   * Builds the audit context from the current request.
   *
   * @param req The request.
   * @returns Audit metadata.
   */
  private auditContext(req: Request) {
    const context = this.requestContext.get();
    return {
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      requestId: context.requestId || String(req.id ?? ''),
    };
  }

  /**
   * Revokes the rotation family of a presented refresh token.
   *
   * @param refreshToken The token presented by the client.
   */
  private async revokeFamilyFor(refreshToken: string): Promise<void> {
    try {
      const digest = TokenService.digest(refreshToken);
      const stored = await this.prisma.client.adminRefreshToken.findUnique({
        where: { tokenHash: digest },
        select: { familyId: true },
      });
      if (stored) {
        await this.auth.revokeFamily(stored.familyId);
      }
    } catch {
      // Signing out must never fail because of a malformed or stale token: the
      // session is already unusable from the caller's point of view.
    }
  }
}

/**
 * Reads the refresh cookie from a response, for tests and for clients that need
 * to confirm the cookie contract.
 *
 * @param response The response carrying the cookie.
 * @returns The raw `Set-Cookie` value for the refresh cookie, or `null`.
 */
export function readRefreshCookie(response: Response): string | null {
  const header = response.getHeader('Set-Cookie');
  const cookies = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`)) ?? null;
}
