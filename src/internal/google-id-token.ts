import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * Verification of Google-signed OIDC ID tokens (BN-TASK-016).
 *
 * Cloud Scheduler calls `POST /internal/tick` with an ID token minted for a
 * dedicated service account (`--oidc-service-account-email`) and for the service
 * URL as audience (`--oidc-token-audience`). The service itself accepts
 * unauthenticated traffic (the API authenticates per route), so Cloud Run's IAM
 * does not check that token: this module does.
 *
 * Done with `node:crypto` against Google's published JWKS instead of pulling in
 * `google-auth-library` for one RS256 check. What is verified, all of it required:
 *
 *  * header `alg` is `RS256` and `kid` is one of Google's current keys;
 *  * the RS256 signature over `header.payload` with that key;
 *  * `iss` is `https://accounts.google.com` (or `accounts.google.com`);
 *  * `aud` is exactly the configured audience;
 *  * `exp` is in the future and `iat` not in the future (60 s of skew);
 *  * `email` is the configured service account and `email_verified` is true.
 */

/** Google's certificate endpoint for ID tokens, in JWK form. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Issuers Google uses on ID tokens. */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** Tolerated clock difference, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

/** One RSA public key of the JWKS. */
export interface Jwk {
  readonly kid: string;
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
  readonly use?: string;
}

/** Where the verifier gets Google's current keys. Injected so tests sign with their own. */
export interface JwksSource {
  keys(): Promise<readonly Jwk[]>;
}

/** Who the token must be for. */
export interface IdTokenPolicy {
  /** Exact `aud`: the service URL the scheduler calls. */
  readonly audience: string;
  /** Exact `email`: the scheduler's service account. */
  readonly email: string;
}

/** Outcome of a verification. Reasons are for logs, never for the response. */
export type IdTokenVerdict =
  | { readonly ok: true; readonly email: string }
  | {
      readonly ok: false;
      readonly reason:
        'malformed' | 'unknown_key' | 'signature' | 'issuer' | 'audience' | 'expired' | 'email';
    };

/**
 * Decodes one base64url JWT segment as JSON.
 *
 * @param segment Segment.
 * @returns The object, or `null` when it is not a JSON object.
 */
function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a Google ID token against a policy.
 *
 * @param token Raw JWT (without `Bearer `).
 * @param policy Audience and service account the token must carry.
 * @param jwks Source of Google's current keys.
 * @param nowSeconds Current time, in seconds since the epoch.
 * @returns The verdict.
 */
export async function verifyGoogleIdToken(
  token: string,
  policy: IdTokenPolicy,
  jwks: JwksSource,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<IdTokenVerdict> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0 || !/^[A-Za-z0-9_-]+$/.test(p))) {
    return { ok: false, reason: 'malformed' };
  }
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = decodeSegment(rawHeader);
  const payload = decodeSegment(rawPayload);
  // RS256 only: `none` and the HMAC family are refused before any key is looked at,
  // so a token cannot pick the algorithm it is checked with.
  if (header === null || payload === null || header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const jwk = (await jwks.keys()).find((key) => key.kid === header['kid'] && key.kty === 'RSA');
  if (jwk === undefined) {
    return { ok: false, reason: 'unknown_key' };
  }
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${rawHeader}.${rawPayload}`),
      key,
      Buffer.from(rawSignature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'signature' };
  }
  if (typeof payload['iss'] !== 'string' || !GOOGLE_ISSUERS.has(payload['iss'])) {
    return { ok: false, reason: 'issuer' };
  }
  if (payload['aud'] !== policy.audience) {
    return { ok: false, reason: 'audience' };
  }
  const exp = payload['exp'];
  const iat = payload['iat'];
  if (
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    exp + CLOCK_SKEW_SECONDS <= nowSeconds ||
    iat - CLOCK_SKEW_SECONDS > nowSeconds
  ) {
    return { ok: false, reason: 'expired' };
  }
  if (payload['email'] !== policy.email || payload['email_verified'] !== true) {
    return { ok: false, reason: 'email' };
  }
  return { ok: true, email: policy.email };
}

/**
 * Google's JWKS, fetched on demand and cached for as long as Google says
 * (`Cache-Control: max-age`, one hour when absent). Google publishes a new key well
 * before it signs with it, so the cache never misses a rotation. A failed fetch
 * keeps serving the previous keys and is retried at most once a minute.
 */
export class GoogleJwksSource implements JwksSource {
  private readonly logger = new Logger(GoogleJwksSource.name);
  private cached: { keys: readonly Jwk[]; expiresAt: number } | null = null;
  private lastFetch = 0;

  constructor(
    private readonly url: string = GOOGLE_JWKS_URL,
    private readonly now: () => number = Date.now,
  ) {}

  async keys(): Promise<readonly Jwk[]> {
    const now = this.now();
    if (this.cached !== null && now < this.cached.expiresAt) {
      return this.cached.keys;
    }
    if (this.cached !== null && now - this.lastFetch < 60_000) {
      return this.cached.keys;
    }
    this.lastFetch = now;
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys)
        ? (body.keys as Jwk[]).filter((k) => typeof k?.kid === 'string' && k.kty === 'RSA')
        : [];
      const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1];
      this.cached = { keys, expiresAt: now + (maxAge === undefined ? 3_600 : Number(maxAge)) * 1000 };
      return keys;
    } catch (error) {
      this.logger.warn(`Could not fetch Google's ID token keys: ${(error as Error).message}`);
      return this.cached?.keys ?? [];
    }
  }
}
