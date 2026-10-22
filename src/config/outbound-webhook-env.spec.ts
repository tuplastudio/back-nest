import { envSchema, validateEnv } from './env.validation';

/**
 * Outbound webhook configuration (BN-TASK-003, BN-TASK-005, BN-TASK-006).
 *
 * Kept apart from env.validation.spec.ts so the outbound keys can be read, and
 * changed, as one block.
 */
const BASE = {
  NODE_ENV: 'production',
  CONTROL_PLANE_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mtb?schema=public',
  TENANT_PLANE_DATABASE_URL: 'postgresql://mtb_app:mtb_app_local_only@localhost:5432/mtb?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PII_HMAC_KEY: 'c'.repeat(24),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  NETPAY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  PAYMENT_REDIRECT_URL: 'https://pay.example.test/return',
  PAYMENT_CANCEL_URL: 'https://pay.example.test/cancel',
  DOCS_BASIC_AUTH_PASSWORD: 'a-real-docs-password-value',
};

function outbound(env: Record<string, string> = {}): Record<string, unknown> {
  return validateEnv({ ...BASE, ...env })['outboundWebhooks'] as Record<string, unknown>;
}

describe('outbound webhook configuration', () => {
  it('delivers by default: an unset OUTBOUND_WEBHOOK_ENABLED means on', () => {
    expect(outbound().enabled).toBe(true);
  });

  it('can still be switched off deliberately', () => {
    expect(outbound({ OUTBOUND_WEBHOOK_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('retries for 24 h by default, configurable with OUTBOUND_WEBHOOK_MAX_AGE_HOURS', () => {
    expect(outbound().maxAgeMs).toBe(24 * 3_600_000);
    expect(outbound({ OUTBOUND_WEBHOOK_MAX_AGE_HOURS: '6' }).maxAgeMs).toBe(6 * 3_600_000);
  });

  it('refuses a retry window outside 1 h to 7 days', () => {
    expect(envSchema.safeParse({ ...BASE, OUTBOUND_WEBHOOK_MAX_AGE_HOURS: '0' }).success).toBe(false);
    expect(envSchema.safeParse({ ...BASE, OUTBOUND_WEBHOOK_MAX_AGE_HOURS: '169' }).success).toBe(false);
  });

  it('caps the backoff at one hour by default', () => {
    expect(outbound().maxBackoffMs).toBe(3_600_000);
  });

  it('does not let the attempt cap cut the 24 h window short by default', () => {
    // At most one attempt an hour once the backoff is capped, so 24 h needs
    // a few dozen attempts; the default cap must not be the thing that ends it.
    expect(outbound().maxAttempts as number).toBeGreaterThanOrEqual(48);
  });

  it('delivers 8 at a time by default, configurable with OUTBOUND_WEBHOOK_CONCURRENCY', () => {
    expect(outbound().concurrency).toBe(8);
    expect(outbound({ OUTBOUND_WEBHOOK_CONCURRENCY: '16' }).concurrency).toBe(16);
    expect(envSchema.safeParse({ ...BASE, OUTBOUND_WEBHOOK_CONCURRENCY: '0' }).success).toBe(false);
  });
});
