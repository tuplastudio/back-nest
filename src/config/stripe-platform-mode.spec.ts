import { validateEnv } from './env.validation';

const BASE = {
  NODE_ENV: 'test',
  CONTROL_PLANE_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mtb?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PII_HMAC_KEY: 'c'.repeat(24),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  NETPAY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  DOCS_BASIC_AUTH_PASSWORD: 'a-real-docs-password-value',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake0000',
};

/** Which Stripe mode a set of variables yields (docs 33, platform-account mode). */
function stripeOf(extra: Record<string, string>) {
  const gateways = validateEnv({ ...BASE, ...extra })['gateways'] as {
    stripe: { clientId: string | null } | null;
    stripePlatformModeRefused: boolean;
  };
  return gateways;
}

describe('Stripe availability matrix', () => {
  it('a test key without a client id is available in platform mode', () => {
    const g = stripeOf({ STRIPE_SECRET_KEY: 'sk_test_fake0000' });
    expect(g.stripe).toMatchObject({ clientId: null });
    expect(g.stripePlatformModeRefused).toBe(false);
  });

  it('a live key without a client id is refused (the safety guard)', () => {
    const g = stripeOf({ STRIPE_SECRET_KEY: 'sk_live_fake0000' });
    expect(g.stripe).toBeNull();
    expect(g.stripePlatformModeRefused).toBe(true);
  });

  it('a client id keeps Connect OAuth, with either kind of key', () => {
    for (const key of ['sk_test_fake0000', 'sk_live_fake0000']) {
      const g = stripeOf({ STRIPE_SECRET_KEY: key, STRIPE_CONNECT_CLIENT_ID: 'ca_fake0000' });
      expect(g.stripe).toMatchObject({ clientId: 'ca_fake0000' });
      expect(g.stripePlatformModeRefused).toBe(false);
    }
  });

  it('without a key or webhook secret Stripe is unavailable and nothing is flagged', () => {
    const g = stripeOf({});
    expect(g.stripe).toBeNull();
    expect(g.stripePlatformModeRefused).toBe(false);
  });
});
