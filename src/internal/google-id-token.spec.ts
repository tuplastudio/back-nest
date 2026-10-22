import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { verifyGoogleIdToken, type Jwk, type JwksSource } from './google-id-token';

/**
 * Verification of the Google-signed OIDC ID token Cloud Scheduler sends to
 * `POST /internal/tick` (BN-TASK-016).
 */

const AUDIENCE = 'https://netpay-api-staging-abc-ul.a.run.app';
const SA = 'netpay-tick@vondi-0q-staging.iam.gserviceaccount.com';
const NOW = 1_800_000_000;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwkOf(key: KeyObject, kid: string): Jwk {
  return { ...(key.export({ format: 'jwk' }) as { n: string; e: string; kty: 'RSA' }), kid, alg: 'RS256' };
}

const jwks: JwksSource = { keys: () => Promise.resolve([jwkOf(publicKey, 'k1')]) };

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** Signs a token the way Google does (RS256), with claims overridable per test. */
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject = privateKey,
): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header }));
  const body = b64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      email: SA,
      email_verified: true,
      iat: NOW - 10,
      exp: NOW + 3000,
      sub: '1234567890',
      ...claims,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(key))}`;
}

const policy = { audience: AUDIENCE, email: SA };

describe('verifyGoogleIdToken (BN-TASK-016)', () => {
  it('accepts a token signed by Google for this audience and service account', async () => {
    await expect(verifyGoogleIdToken(token(), policy, jwks, NOW)).resolves.toEqual({ ok: true, email: SA });
  });

  it('accepts the bare accounts.google.com issuer too', async () => {
    const verdict = await verifyGoogleIdToken(token({ iss: 'accounts.google.com' }), policy, jwks, NOW);
    expect(verdict.ok).toBe(true);
  });

  it.each([
    ['another audience', { aud: 'https://evil.example' }, 'audience'],
    ['another service account', { email: 'someone@example.iam.gserviceaccount.com' }, 'email'],
    ['an unverified e-mail', { email_verified: false }, 'email'],
    ['an expired token', { exp: NOW - 120 }, 'expired'],
    ['a token issued in the future', { iat: NOW + 600 }, 'expired'],
    ['another issuer', { iss: 'https://evil.example' }, 'issuer'],
  ])('refuses %s', async (_label, claims, reason) => {
    await expect(verifyGoogleIdToken(token(claims), policy, jwks, NOW)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses a token signed by another key', async () => {
    const verdict = await verifyGoogleIdToken(token({}, {}, other.privateKey), policy, jwks, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a key id Google does not publish', async () => {
    const verdict = await verifyGoogleIdToken(token({}, { kid: 'nope' }), policy, jwks, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('refuses alg none and HS256 whatever the signature says', async () => {
    for (const alg of ['none', 'HS256']) {
      const verdict = await verifyGoogleIdToken(token({}, { alg }), policy, jwks, NOW);
      expect(verdict).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses garbage and an API key', async () => {
    for (const raw of ['', 'abc', 'a.b.c', 'mtb_abcdefgh_' + 'x'.repeat(43)]) {
      const verdict = await verifyGoogleIdToken(raw, policy, jwks, NOW);
      expect(verdict.ok).toBe(false);
    }
  });

  it('refuses a tampered payload', async () => {
    const [head, , sig] = token().split('.');
    const forged = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: AUDIENCE, email: SA }));
    const verdict = await verifyGoogleIdToken(`${head}.${forged}.${sig}`, policy, jwks, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'signature' });
  });
});
