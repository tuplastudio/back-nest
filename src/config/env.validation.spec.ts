import { envSchema, validateEnv } from './env.validation';

const SECRETS = {
  CONTROL_PLANE_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mtb?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PII_HMAC_KEY: 'c'.repeat(24),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  // Required since payments became a wired module: it encrypts each tenant's
  // provider secret, and is deliberately a different key from the PII one.
  NETPAY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  // Required in production since BN-TASK-028 (see payment-urls.spec.ts).
  PAYMENT_REDIRECT_URL: 'https://pay.example.test/return',
  PAYMENT_CANCEL_URL: 'https://pay.example.test/cancel',
};

const DOCS_PASSWORD = 'a-real-docs-password-value';
// A production configuration must carry a distinct data-plane credential, or the
// tenant tables' row-level security is never enforced.
const TENANT_PLANE_URL = 'postgresql://mtb_app:mtb_app_local_only@localhost:5432/mtb?schema=public';

function parse(env: Record<string, string>) {
  return envSchema.safeParse({ DOCS_BASIC_AUTH_PASSWORD: DOCS_PASSWORD, ...env });
}

function messages(result: ReturnType<typeof parse>): string {
  return result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');
}

describe('env validation (regression: NODE_ENV must not silently default to development)', () => {
  it('rejects an absent NODE_ENV instead of assuming development', () => {
    const result = parse({ ...SECRETS });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('NODE_ENV must be explicitly set');
  });

  it.each(['development', 'test', 'production'])('accepts an explicit NODE_ENV=%s', (value) => {
    expect(parse({ ...SECRETS, NODE_ENV: value, TENANT_PLANE_DATABASE_URL: TENANT_PLANE_URL }).success).toBe(
      true,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(parse({ ...SECRETS, NODE_ENV: 'staging' }).success).toBe(false);
  });

  it('does not report development as the resolved profile when NODE_ENV is missing', () => {
    const result = parse({ ...SECRETS });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'NODE_ENV')).toBe(true);
    }
  });
});

describe('env validation (regression: docs credential is required whenever docs are served)', () => {
  it('rejects DOCS_ENABLED=true with no password', () => {
    const result = envSchema.safeParse({ ...SECRETS, NODE_ENV: 'production' });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('DOCS_BASIC_AUTH_PASSWORD is required when DOCS_ENABLED=true');
  });

  it('rejects the published .env.example placeholder in every environment', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      const result = parse({
        ...SECRETS,
        NODE_ENV: nodeEnv,
        DOCS_BASIC_AUTH_PASSWORD: 'change-me-docs-password',
      });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain('.env.example placeholder');
    }
  });

  it('rejects the values prisma/seed.ts used to commit (regression)', () => {
    // The seed used to default to these two committed constants, which passed
    // every structural rule, so a deployment could boot on publicly known
    // blind-index and AES keys. The fallbacks are gone; the validator refuses the
    // values regardless, so reintroducing one cannot silently pass.
    const seedHmac = 'seed-only-blind-index-key';
    const seedAes = Buffer.alloc(32, 7).toString('base64');
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(envSchema.safeParse({ ...SECRETS, NODE_ENV: nodeEnv, PII_HMAC_KEY: seedHmac }).success).toBe(
        false,
      );
      expect(
        envSchema.safeParse({ ...SECRETS, NODE_ENV: nodeEnv, PII_ENCRYPTION_KEY: seedAes }).success,
      ).toBe(false);
    }
  });

  it('rejects a short password', () => {
    const result = parse({ ...SECRETS, NODE_ENV: 'production', DOCS_BASIC_AUTH_PASSWORD: 'short' });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('at least 16 characters');
  });

  it('accepts a real password', () => {
    expect(
      parse({ ...SECRETS, NODE_ENV: 'production', TENANT_PLANE_DATABASE_URL: TENANT_PLANE_URL }).success,
    ).toBe(true);
  });

  it('does not require a password when docs are disabled', () => {
    const result = envSchema.safeParse({
      ...SECRETS,
      NODE_ENV: 'production',
      DOCS_ENABLED: 'false',
      TENANT_PLANE_DATABASE_URL: TENANT_PLANE_URL,
    });
    expect(result.success).toBe(true);
  });
});

describe('env validation (regression: the payments key is fail-fast too)', () => {
  it('applies the same fail-fast rules to the payments key', () => {
    // The payments key encrypts a credential that can move money, so the same
    // fail-fast rules apply to it as to every other secret.
    const base = { ...SECRETS, NODE_ENV: 'test' };
    expect(messages(parse({ ...base, NETPAY_ENCRYPTION_KEY: 'A'.repeat(43) + '=' }))).toContain(
      'NETPAY_ENCRYPTION_KEY still holds the example value.',
    );
    expect(
      messages(parse({ ...base, NETPAY_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })),
    ).toContain('NETPAY_ENCRYPTION_KEY must decode to exactly 32 bytes.');
    // Omitting it is fatal. This file does not attach custom messages to a
    // missing string, matching every other secret, so only the refusal is
    // asserted here.
    const { NETPAY_ENCRYPTION_KEY: _omitted, ...withoutKey } = base;
    expect(parse(withoutKey).success).toBe(false);
  });
});

describe('env validation (pre-existing controls must survive)', () => {
  it('still refuses identical access and refresh secrets', () => {
    const result = parse({
      ...SECRETS,
      NODE_ENV: 'production',
      JWT_REFRESH_SECRET: SECRETS.JWT_ACCESS_SECRET,
    });
    expect(messages(result)).toContain('JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET.');
  });

  it('still refuses the example JWT secret', () => {
    const result = parse({
      ...SECRETS,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'change-me-jwt-access-secret',
    });
    expect(result.success).toBe(false);
  });

  it('still refuses a wildcard CORS origin in production', () => {
    const result = parse({
      ...SECRETS,
      NODE_ENV: 'production',
      TENANT_PLANE_DATABASE_URL: TENANT_PLANE_URL,
      CORS_ORIGINS: '*',
    });
    expect(messages(result)).toContain('CORS_ORIGINS');
  });

  it('still refuses a PII key that is not exactly 32 bytes', () => {
    const result = parse({
      ...SECRETS,
      NODE_ENV: 'production',
      PII_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
    });
    expect(result.success).toBe(false);
  });
});

describe('env validation (regression: production must carry a data-plane credential)', () => {
  it('refuses to boot in production without TENANT_PLANE_DATABASE_URL', () => {
    // Without it the data plane runs as the provisioning role and the tenant
    // tables' row-level security is silently not enforced.
    const result = envSchema.safeParse({
      ...SECRETS,
      NODE_ENV: 'production',
      DOCS_ENABLED: 'false',
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('TENANT_PLANE_DATABASE_URL is required in production');
  });

  it('rejects an empty TENANT_PLANE_DATABASE_URL', () => {
    expect(
      envSchema.safeParse({
        ...SECRETS,
        NODE_ENV: 'production',
        DOCS_ENABLED: 'false',
        TENANT_PLANE_DATABASE_URL: '',
      }).success,
    ).toBe(false);
  });

  it('still boots outside production without it, so local development works', () => {
    // The degradation is deliberate and loud in logs, not a boot failure: it
    // would otherwise make single-role local setups impossible.
    expect(
      envSchema.safeParse({ ...SECRETS, NODE_ENV: 'development', DOCS_BASIC_AUTH_PASSWORD: DOCS_PASSWORD })
        .success,
    ).toBe(true);
    expect(
      envSchema.safeParse({ ...SECRETS, NODE_ENV: 'test', DOCS_BASIC_AUTH_PASSWORD: DOCS_PASSWORD }).success,
    ).toBe(true);
  });
});

describe('env validation: security settings (BN-TASK-032/034/035/040)', () => {
  const base = {
    ...SECRETS,
    DOCS_BASIC_AUTH_PASSWORD: DOCS_PASSWORD,
    TENANT_PLANE_DATABASE_URL: TENANT_PLANE_URL,
  };
  const auth = (env: Record<string, string>) => (validateEnv(env)['auth'] as Record<string, unknown>) ?? {};

  it('requires admin MFA by default in production (staging runs as production) and not elsewhere', () => {
    expect(auth({ ...base, NODE_ENV: 'production' })['mfaRequiredForAdmins']).toBe(true);
    expect(auth({ ...base, NODE_ENV: 'test' })['mfaRequiredForAdmins']).toBe(false);
    expect(
      auth({ ...base, NODE_ENV: 'production', MFA_REQUIRED_FOR_ADMINS: 'false' })['mfaRequiredForAdmins'],
    ).toBe(false);
  });

  it('caps the authorization cache TTL at 5 s', () => {
    expect(auth({ ...base, NODE_ENV: 'test' })['authzCacheTtlMs']).toBe(5_000);
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'test', AUTHZ_CACHE_TTL_MS: '30000' }).success).toBe(
      false,
    );
  });

  it('validates keyring JSON', () => {
    const key = Buffer.alloc(32, 5).toString('base64');
    const good = JSON.stringify({ current: '2', keys: { '1': key, '2': key } });
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'test', PII_KEYS_JSON: good }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'test', NETPAY_KEYS_JSON: good }).success).toBe(true);
    const missingCurrent = JSON.stringify({ current: '3', keys: { '1': key } });
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'test', PII_KEYS_JSON: missingCurrent }).success).toBe(
      false,
    );
  });

  it('accepts only redis:// or rediss:// for the shared throttler storage', () => {
    expect(
      envSchema.safeParse({ ...base, NODE_ENV: 'test', THROTTLER_REDIS_URL: 'rediss://:pw@10.0.0.3:6378/0' })
        .success,
    ).toBe(true);
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'test', THROTTLER_REDIS_URL: 'http://x' }).success).toBe(
      false,
    );
  });
});
