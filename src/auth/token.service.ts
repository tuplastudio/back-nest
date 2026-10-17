import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config.service';

/**
 * A freshly issued access/refresh token pair.
 */
export interface TokenPair {
  /** Signed JWT access token. */
  readonly accessToken: string;
  /** Opaque refresh token. Only its SHA-256 digest is ever stored. */
  readonly refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  readonly accessTokenExpiresAt: number;
  /** Epoch milliseconds when the refresh token expires. */
  readonly refreshTokenExpiresAt: number;
  /** Rotation family this refresh token belongs to. */
  readonly familyId: string;
  /** Digest of the refresh token, to be persisted by the caller. */
  readonly refreshTokenDigest: string;
}

/**
 * Payload embedded in the access token.
 *
 * Deliberately minimal: no roles, no permissions, no PII. Guards perform a fresh
 * database read for authorisation decisions, so a token never becomes a
 * long-lived cache of privileges. That costs one indexed lookup per request and
 * removes a whole class of "stale permissions" bugs.
 */
export interface AccessTokenPayload {
  /** Subject: the principal's primary key. */
  readonly sub: string;
  /** Unique token identifier (RFC 7519 `jti`). */
  readonly jti: string;
  /** Token kind, so a refresh token can never be used as an access token. */
  readonly typ: 'access';
  /** Principal kind, used to select the verification strategy. */
  readonly kind: 'platform-admin' | 'tenant-user';
  /** Tenant the token is scoped to, for tenant members. */
  readonly tid?: string;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
  /** Expiry, epoch seconds. */
  readonly exp: number;
}

/**
 * Payload embedded in the signed refresh token.
 *
 * The refresh token is a JWT so it is self-describing, yet the authoritative
 * record is the database row: the digest is looked up, expiry and revocation are
 * checked there, and reuse detection works on the stored family. A JWT-only
 * design could not revoke a stolen token.
 */
export interface RefreshTokenPayload {
  /** Subject: the principal's primary key. */
  readonly sub: string;
  /**
   * Unique token identifier (RFC 7519 `jti`).
   *
   * Essential here: every other claim is second-resolution, so two refreshes
   * inside the same second would otherwise mint byte-identical tokens, break the
   * unique `tokenHash` index and hand the client the same "new" token twice.
   */
  readonly jti: string;
  /** Token kind. */
  readonly typ: 'refresh';
  /** Rotation family identifier. */
  readonly fid: string;
  /** Principal kind. */
  readonly kind: 'platform-admin' | 'tenant-user';
  /** Tenant the token is scoped to, for tenant members. */
  readonly tid?: string;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
  /** Expiry, epoch seconds. */
  readonly exp: number;
}

/**
 * A refresh token ready to be persisted.
 */
export interface IssuedRefreshToken {
  /** The signed token handed to the client exactly once. */
  readonly token: string;
  /** SHA-256 digest; this is what goes into the database. */
  readonly digest: string;
  /** Rotation family identifier. */
  readonly familyId: string;
  /** Epoch milliseconds when the token expires. */
  readonly expiresAt: number;
}

/**
 * Issues and verifies access and refresh tokens.
 *
 * Token strategy
 * --------------
 * * **Access token** — short-lived (default 15 minutes) signed JWT. Stateless, so
 *   it is not looked up on the request path.
 * * **Refresh token** — long-lived JWT whose SHA-256 digest is stored. Rotated on
 *   every use; presenting an already-rotated token revokes the entire family,
 *   which is the standard defence against refresh-token theft.
 *
 * The access and refresh secrets are configured separately and validated as
 * distinct at boot, so a leaked access-token secret cannot be used to mint a
 * refresh token.
 *
 * Why roles are absent from the access token
 * ------------------------------------------
 * Embedding roles would let an administrator keep elevated access until the token
 * expires. Instead the token identifies the principal and the guard re-reads the
 * row, so suspension takes effect on the next request.
 */
@Injectable()
export class TokenService {
  /**
   * @param jwtService JWT signer configured by `AuthModule`.
   * @param config Validated application configuration.
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Signs a short-lived access token.
   *
   * @param subject Principal primary key.
   * @param kind Which principal table to resolve on the request path.
   * @param tenantId Tenant scope, for tenant members.
   * @returns The signed JWT and its expiry as epoch milliseconds.
   */
  issueAccessToken(
    subject: string,
    kind: 'platform-admin' | 'tenant-user',
    tenantId?: string,
  ): { token: string; expiresAt: number } {
    const expiresInMs = this.durationToMs(this.config.jwtAccessTtl);
    const payload: Omit<AccessTokenPayload, 'iat' | 'exp'> = {
      sub: subject,
      jti: randomUUID(),
      typ: 'access',
      kind,
      ...(tenantId ? { tid: tenantId } : {}),
    };

    const token = this.jwtService.sign(payload, {
      secret: this.config.jwtAccessSecret,
      expiresIn: Math.floor(expiresInMs / 1000),
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });

    return { token, expiresAt: Date.now() + expiresInMs };
  }

  /**
   * Issues a refresh token together with the digest the caller must persist.
   *
   * @param subject Principal primary key.
   * @param kind Which principal table the token belongs to.
   * @param familyId Rotation family; reuse detection revokes the whole family.
   * @param tenantId Tenant scope for tenant members.
   * @returns The signed token, its digest, family and expiry.
   */
  issueRefreshToken(
    subject: string,
    kind: 'platform-admin' | 'tenant-user',
    familyId: string = randomUUID(),
    tenantId?: string,
  ): IssuedRefreshToken {
    const expiresInMs = this.durationToMs(this.config.jwtRefreshTtl);
    const payload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
      sub: subject,
      jti: randomUUID(),
      typ: 'refresh',
      fid: familyId,
      kind,
      ...(tenantId ? { tid: tenantId } : {}),
    };

    const token = this.jwtService.sign(payload, {
      secret: this.config.jwtRefreshSecret,
      expiresIn: Math.floor(expiresInMs / 1000),
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });

    return {
      token,
      digest: TokenService.digest(token),
      familyId,
      expiresAt: Date.now() + expiresInMs,
    };
  }

  /**
   * Issues a complete access/refresh pair for a principal.
   *
   * @param subject Principal primary key.
   * @param kind Which principal table the principal belongs to.
   * @param tenantId Tenant scope, for tenant members.
   * @param familyId Existing rotation family when refreshing, new family on sign-in.
   * @returns The token pair plus the digest to persist for the refresh token.
   */
  issuePair(
    subject: string,
    kind: 'platform-admin' | 'tenant-user',
    tenantId?: string,
    familyId?: string,
  ): TokenPair {
    const access = this.issueAccessToken(subject, kind, tenantId);
    const refresh = this.issueRefreshToken(subject, kind, familyId, tenantId);

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshTokenExpiresAt: refresh.expiresAt,
      familyId: refresh.familyId,
      refreshTokenDigest: refresh.digest,
    };
  }

  /**
   * Verifies an access token's signature, issuer, audience and expiry.
   *
   * @param token Raw JWT from the `Authorization` header.
   * @returns The decoded payload.
   * @throws {Error} When the token is invalid, expired or has the wrong type.
   */
  verifyAccessToken(token: string): AccessTokenPayload {
    const payload = this.jwtService.verify<AccessTokenPayload>(token, {
      secret: this.config.jwtAccessSecret,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });

    if (payload.typ !== 'access') {
      throw new Error('Wrong token type: a refresh token cannot authorise a request.');
    }
    return payload;
  }

  /**
   * Verifies a refresh token's signature, issuer, audience and expiry.
   *
   * @param token Raw refresh token.
   * @returns The decoded payload.
   * @throws {Error} When the token is invalid, expired or of the wrong type.
   */
  verifyRefreshToken(token: string): RefreshTokenPayload {
    const payload = this.jwtService.verify<RefreshTokenPayload>(token, {
      secret: this.config.jwtRefreshSecret,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });

    if (payload.typ !== 'refresh') {
      throw new Error('Wrong token type: an access token cannot refresh a session.');
    }
    return payload;
  }

  /**
   * Decodes a token without verifying it.
   *
   * Only used to read the `typ` claim of an API key presented as a bearer token,
   * where the signature is not what decides the outcome.
   *
   * @param token Raw token.
   * @returns The decoded payload, or `null` when the token is unreadable.
   */
  static decodeUnverified(token: string): { typ?: string; sub?: string } | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
        typ?: string;
        sub?: string;
      };
    } catch {
      return null;
    }
  }

  /**
   * Computes the SHA-256 digest stored for a refresh token.
   *
   * SHA-256 (not Argon2) is the right primitive here: the input is 256 bits of
   * cryptographic randomness, so there is no dictionary to attack and a fast
   * hash keeps refresh latency low.
   *
   * @param token Raw token.
   * @returns Hex digest used as the database lookup key.
   */
  static digest(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Generates a cryptographically random opaque token.
   *
   * @param bytes Number of random bytes; 32 provides 256 bits of entropy.
   * @returns Base64url encoded token.
   */
  static randomOpaqueToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /**
   * Converts a duration string (`15m`, `30d`) to milliseconds.
   *
   * @param value Duration string.
   * @returns Equivalent milliseconds.
   * @throws {Error} When the format is not recognised.
   */
  private durationToMs(value: string): number {
    const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
    if (!match) {
      throw new Error(`Invalid duration string: ${value}`);
    }
    const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Number(match[1]) * multipliers[match[2]];
  }
}
