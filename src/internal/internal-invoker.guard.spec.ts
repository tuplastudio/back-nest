import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { InternalInvokerGuard } from './internal-invoker.guard';
import type { JwksSource } from './google-id-token';
import type { AppConfig } from '../config/app-config.service';

/**
 * The guard of `POST /internal/tick` (BN-TASK-016): only the Cloud Scheduler
 * service account's Google ID token, minted for this service, gets through.
 */

const AUDIENCE = 'https://netpay-api-staging-abc-ul.a.run.app';
const SA = 'netpay-tick@vondi-0q-staging.iam.gserviceaccount.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks: JwksSource = {
  keys: () =>
    Promise.resolve([
      { ...(publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: 'RSA' }), kid: 'k1' },
    ]),
};

function idToken(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      email: SA,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

function guard(tick: { serviceAccountEmail: string | null; audience: string | null }): InternalInvokerGuard {
  return new InternalInvokerGuard({ internalTick: tick } as unknown as AppConfig, jwks);
}

function contextWith(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

const configured = { serviceAccountEmail: SA, audience: AUDIENCE };

describe('InternalInvokerGuard (BN-TASK-016)', () => {
  it('lets the scheduler service account in', async () => {
    await expect(guard(configured).canActivate(contextWith(`Bearer ${idToken()}`))).resolves.toBe(true);
  });

  it('answers 401 without a token, with garbage, or with a token for another audience', async () => {
    for (const header of [undefined, 'Bearer nope', `Bearer ${idToken({ aud: 'https://other.example' })}`]) {
      await expect(guard(configured).canActivate(contextWith(header))).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('answers 403 to a valid Google token of another identity', async () => {
    await expect(
      guard(configured).canActivate(contextWith(`Bearer ${idToken({ email: 'dev@example.com' })}`)),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('refuses every call when the service account or the audience is not configured', async () => {
    for (const tick of [
      { serviceAccountEmail: null, audience: AUDIENCE },
      { serviceAccountEmail: SA, audience: null },
    ]) {
      await expect(guard(tick).canActivate(contextWith(`Bearer ${idToken()}`))).rejects.toMatchObject({
        status: 401,
      });
    }
  });
});
