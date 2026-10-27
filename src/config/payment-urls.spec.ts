import { ESLint } from 'eslint';
import { validateEnv } from './env.validation';
import { DEV_PAYMENT_URL_FALLBACK, paymentUrls, resetPaymentUrlsForTesting } from './payment-urls';

const BASE = {
  CONTROL_PLANE_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mtb?schema=public',
  TENANT_PLANE_DATABASE_URL: 'postgresql://mtb_app:x@localhost:5432/mtb?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PII_HMAC_KEY: 'c'.repeat(24),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  NETPAY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  DOCS_ENABLED: 'false',
};

const URLS = {
  PAYMENT_REDIRECT_URL: 'https://pay.example.test/return',
  PAYMENT_CANCEL_URL: 'https://pay.example.test/cancel',
};

describe('payment redirect/cancel URLs come only from validated config (BN-TASK-028)', () => {
  afterEach(() => resetPaymentUrlsForTesting());

  it('refuses to boot in production when PAYMENT_REDIRECT_URL is missing, with a clear message', () => {
    expect(() =>
      validateEnv({ ...BASE, NODE_ENV: 'production', PAYMENT_CANCEL_URL: URLS.PAYMENT_CANCEL_URL }),
    ).toThrow(/PAYMENT_REDIRECT_URL is required in production/);
  });

  it('refuses to boot in production when PAYMENT_CANCEL_URL is missing', () => {
    expect(() =>
      validateEnv({ ...BASE, NODE_ENV: 'production', PAYMENT_REDIRECT_URL: URLS.PAYMENT_REDIRECT_URL }),
    ).toThrow(/PAYMENT_CANCEL_URL is required in production/);
  });

  it('rejects a relative URL in any environment', () => {
    expect(() => validateEnv({ ...BASE, NODE_ENV: 'test', PAYMENT_REDIRECT_URL: '/return' })).toThrow(
      /PAYMENT_REDIRECT_URL must be an absolute URL/,
    );
  });

  it('publishes the validated values to the payment code', () => {
    const tree = validateEnv({ ...BASE, NODE_ENV: 'production', ...URLS });

    expect(tree['payments']).toMatchObject({
      redirectUrl: URLS.PAYMENT_REDIRECT_URL,
      cancelUrl: URLS.PAYMENT_CANCEL_URL,
    });
    expect(paymentUrls()).toEqual({
      redirectUrl: URLS.PAYMENT_REDIRECT_URL,
      cancelUrl: URLS.PAYMENT_CANCEL_URL,
      quickLinkBaseUrl: null,
    });
  });

  it('falls back to a placeholder only outside production', () => {
    validateEnv({ ...BASE, NODE_ENV: 'development' });
    expect(paymentUrls()).toEqual({
      redirectUrl: DEV_PAYMENT_URL_FALLBACK,
      cancelUrl: DEV_PAYMENT_URL_FALLBACK,
      quickLinkBaseUrl: null,
    });
  });
});

describe('lint: process.env is confined to src/config (BN-TASK-028)', () => {
  const eslint = new ESLint();

  it.each([
    'src/payments/payment-orders.service.ts',
    'src/payments/netpay-endpoints.ts',
    'src/main.ts',
    'src/common/logging/json-logger.ts',
  ])('forbids process.env in %s', async (file) => {
    const config = (await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown> };
    expect(config.rules['no-process-env']).toEqual([2]);
  });

  it.each(['src/config/env.validation.ts', 'src/config/payment-urls.ts', 'scripts/migrate.ts'])(
    'allows process.env in %s',
    async (file) => {
      const config = (await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown> };
      expect(config.rules['no-process-env']).toEqual([0]);
    },
  );
});
