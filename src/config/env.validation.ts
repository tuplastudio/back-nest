import { z } from 'zod';
import { keyringJsonProblem } from '../pii/keyring';
import { DEV_PAYMENT_URL_FALLBACK, paymentUrlFields, setPaymentUrls } from './payment-urls';

/**
 * Duration string accepted by the configuration, e.g. `900ms`, `15m`, `30d`.
 */
const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'Duration must look like "900ms", "15m", "2h" or "30d".');

/**
 * Comma separated origin list, normalised into an array.
 *
 * The `.default()` sits on the *input* side of the transform: Zod applies a
 * default declared after `.transform()` to the transform's output type, which
 * would require the default to already be an array.
 */
const csv = z
  .string()
  .default('http://localhost:3000')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

/**
 * Schema for the environment variables the application requires.
 *
 * Fail-fast behaviour is deliberate: a missing or weak secret aborts the boot
 * rather than silently degrading security in production.
 */
export const envSchema = z
  .object({
    // NODE_ENV has no default on purpose. It selects the security profile: it decides
    // whether the API reference is served behind HTTP Basic auth, whether HSTS is
    // emitted, and whether the refresh cookie carries `Secure`. Defaulting it to
    // `development` meant an unset variable silently produced the least-protected
    // profile on the documented `npm start` / `npm run start:prod` paths, so the
    // value is required rather than guessed. Every shipped template (`.env.example`,
    // `.env.test.example`) sets it.
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      message: 'NODE_ENV must be explicitly set to development, test or production',
    }),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_PREFIX: z.string().min(1).default('api/v1'),
    CORS_ORIGINS: csv,
    API_BASE_DOMAIN: z.string().min(1).default('netpay-api-lfspf6pqtq-ul.a.run.app'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    CONTROL_PLANE_DATABASE_URL: z
      .string()
      .min(1, 'CONTROL_PLANE_DATABASE_URL is required')
      .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
        message: 'CONTROL_PLANE_DATABASE_URL must be a PostgreSQL connection string.',
      }),
    // The data plane connects as a different, non-owning role. Row-level security
    // is unenforced for a superuser and bypassed by a table owner, so that layer
    // only holds while this is a distinct, restricted credential. Optional, so a
    // single-role deployment still boots, but then the tenant tables have no
    // database-level enforcement behind the schema binding — see
    // docs/SECURITY.md.
    TENANT_PLANE_DATABASE_URL: z
      .string()
      .min(1, 'TENANT_PLANE_DATABASE_URL must not be empty when set')
      .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
        message: 'TENANT_PLANE_DATABASE_URL must be a PostgreSQL connection string.',
      })
      .optional(),
    TENANT_CLIENT_CACHE_MAX: z.coerce.number().int().min(1).max(10_000).default(200),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
    DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters.')
      .refine((value) => value !== 'change-me-access-secret-at-least-32-characters-long', {
        message: 'JWT_ACCESS_SECRET still holds the example value.',
      }),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters.')
      .refine((value) => value !== 'change-me-refresh-secret-at-least-32-characters-long', {
        message: 'JWT_REFRESH_SECRET still holds the example value.',
      }),
    PII_HMAC_KEY: z
      .string()
      .min(16, 'PII_HMAC_KEY must be at least 16 characters.')
      .refine((value) => value !== 'change-me-blind-index-key', {
        message: 'PII_HMAC_KEY still holds the example value.',
      })
      // Historically `prisma/seed.ts` fell back to a committed constant when this
      // was unset, and the validator did not know about it, so a deployment could
      // come up on a key anyone could read from the repository. The fallback is
      // gone; refuse the value anyway in case it is reintroduced or pasted.
      .refine((value) => value !== 'seed-only-blind-index-key', {
        message: 'PII_HMAC_KEY holds a value committed to this repository.',
      }),
    // Where Netpay sends the buyer after a hosted checkout. No default: the
    // superRefine below requires both in production (BN-REQ-CFG-006), and
    // validateEnv substitutes a localhost placeholder only outside it.
    ...paymentUrlFields,
    NETPAY_ENCRYPTION_KEY: z
      .string()
      .min(40, 'NETPAY_ENCRYPTION_KEY must be a base64 encoded 32-byte key.')
      .refine((value) => value !== 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', {
        message: 'NETPAY_ENCRYPTION_KEY still holds the example value.',
      })
      .refine(
        (value) => {
          try {
            return Buffer.from(value, 'base64').length === 32;
          } catch {
            return false;
          }
        },
        { message: 'NETPAY_ENCRYPTION_KEY must decode to exactly 32 bytes.' },
      ),

    OUTBOUND_WEBHOOK_REQUIRE_HTTPS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    OUTBOUND_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),
    // A safety cap only: the retry window (OUTBOUND_WEBHOOK_MAX_AGE_HOURS) is what
    // normally ends a delivery, and with the backoff capped at an hour a 24 h
    // window takes a few dozen attempts. A low cap would end it early.
    OUTBOUND_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(100),
    OUTBOUND_WEBHOOK_BASE_BACKOFF_MS: z.coerce.number().int().min(100).max(3_600_000).default(1000),
    // Capped at an hour (BN-REQ-EVT-007): a longer wait would leave fewer
    // attempts in the window than the contract promises subscribers.
    OUTBOUND_WEBHOOK_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).max(3_600_000).default(3_600_000),
    // How long a delivery is retried before it is DEAD, and how long an endpoint
    // must fail continuously before it is disabled automatically.
    OUTBOUND_WEBHOOK_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    // Deliveries in flight at once per instance.
    OUTBOUND_WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    OUTBOUND_WEBHOOK_JITTER_MS: z.coerce.number().int().min(0).max(60_000).default(250),
    OUTBOUND_WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(600_000).default(5000),
    OUTBOUND_WEBHOOK_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    OUTBOUND_WEBHOOK_AUTO_DISABLE_AFTER: z.coerce.number().int().min(1).max(1000).default(20),
    OUTBOUND_WEBHOOK_MAX_TENANTS_PER_TICK: z.coerce.number().int().min(1).max(10_000).default(200),
    OUTBOUND_WEBHOOK_ALLOWED_CIDRS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    // On unless switched off (BN-REQ-EVT-003): a tenant with an ACTIVE endpoint
    // expects deliveries. Off is still possible (a canary, for instance), and
    // /health/ready then reports `degraded` while ACTIVE endpoints exist.
    // Merchant-initiated charges to stored cards without CVV (recurring billing).
    // Off unless Netpay confirms the merchant account supports them; read by
    // `AppConfig.netpayMerchantInitiatedEnabled` (POST orders/:id/charge-stored).
    NETPAY_MIT_ENABLED: z.enum(['true', 'false']).optional(),
    OUTBOUND_WEBHOOK_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    // This deployment's public origin (`https://netpay-api-staging-….run.app`, no
    // path). The inbound webhook URL Netpay should call is
    // `${PUBLIC_BASE_URL}/api/v1/payments/webhook/{token}`; the drift check
    // (BN-REQ-CFG-004) compares Netpay's registration against it. Unset: only the
    // token is compared, and the origin is reported as unknown.
    PUBLIC_BASE_URL: z
      .string()
      .regex(/^https?:\/\/[^/\s?#]+$/, 'PUBLIC_BASE_URL must be an origin such as https://api.example.com.')
      .optional(),

    // Reconciliation of non-terminal orders (BN-REQ-REC-001…004). The in-process
    // timer runs while an instance is alive; with min-instances 0 that means only
    // while there is traffic, so staging also gets a Cloud Scheduler call to
    // POST /internal/tick (scripts/gcp/scheduler-internal-tick.sh).
    RECONCILE_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
    // Orders untouched for less than this are left to the request, the webhook or
    // the storefront; also the lease one worker holds on an order it checked.
    RECONCILE_MIN_AGE_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(300_000),
    RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    // A charge waiting for 3-D Secure this long is EXPIRED (BN-REQ-REC-002).
    RECONCILE_THREEDS_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
    // A CHARGE_UNKNOWN order with no transaction known to Netpay goes back to PENDING
    // after this long (docs/RUNBOOK-PAYMENTS.md §1.1).
    RECONCILE_CHARGE_UNKNOWN_GRACE_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(7 * 86_400_000)
      .default(3_600_000),
    // Calls to Netpay per second and tenant, at most.
    RECONCILE_NETPAY_RATE_PER_SECOND: z.coerce.number().int().min(1).max(50).default(5),

    // POST /internal/tick (Cloud Scheduler): only a Google-signed OIDC ID token
    // for this service account, minted for this audience, is accepted. Unset
    // e-mail: the endpoint refuses every call.
    INTERNAL_TICK_SA_EMAIL: z.email('INTERNAL_TICK_SA_EMAIL must be a service account e-mail.').optional(),
    // Audience the token must carry: the service URL the scheduler calls. Defaults
    // to PUBLIC_BASE_URL.
    INTERNAL_TICK_AUDIENCE: z
      .string()
      .regex(/^https:\/\/[^\s]+$/, 'INTERNAL_TICK_AUDIENCE must be an https URL.')
      .optional(),

    PII_ENCRYPTION_KEY: z
      .string()
      .min(40, 'PII_ENCRYPTION_KEY must be a base64 encoded 32-byte key.')
      .refine((value) => value !== 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', {
        message: 'PII_ENCRYPTION_KEY still holds the example value.',
      })
      // See the note on PII_HMAC_KEY: this was the seed's committed AES fallback
      // (`Buffer.alloc(32, 7)`), which cleared every structural rule below.
      .refine((value) => value !== 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', {
        message: 'PII_ENCRYPTION_KEY holds a value committed to this repository.',
      })
      .refine(
        (value) => {
          try {
            return Buffer.from(value, 'base64').length === 32;
          } catch {
            return false;
          }
        },
        { message: 'PII_ENCRYPTION_KEY must decode to exactly 32 bytes.' },
      ),

    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_TTL: duration.default('30d'),
    JWT_ISSUER: z.string().min(1).default('netpay-api'),
    JWT_AUDIENCE: z.string().min(1).default('netpay-api-v1'),

    ARGON2_MEMORY_COST: z.coerce.number().int().min(1024).max(1_048_576).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(1).max(16).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

    AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    AUTH_LOCKOUT_DURATION: duration.default('15m'),
    AUTH_THROTTLE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
    AUTH_THROTTLE_TTL: duration.default('60s'),

    THROTTLE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(300),
    THROTTLE_TTL: duration.default('60s'),
    // Shared rate-limit storage (Redis / Memorystore) so every instance counts
    // against one budget (BN-REQ-SEC-004). Unset: per-instance memory.
    THROTTLER_REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\/[^\s]+$/, 'THROTTLER_REDIS_URL must be a redis:// or rediss:// URL.')
      .optional(),

    // TOTP for platform administrators (BN-REQ-SEC-006). Unset means: required
    // in production (which staging also runs as), optional elsewhere.
    MFA_REQUIRED_FOR_ADMINS: z.enum(['true', 'false']).optional(),

    // Tenant status / role caches (BN-REQ-SEC-012): a suspension or role
    // revocation reaches every instance within this window. Capped at 5 s.
    AUTHZ_CACHE_TTL_MS: z.coerce.number().int().min(0).max(5_000).default(5_000),

    // Versioned keyrings (BN-REQ-SEC-007): {"current":"2","keys":{"1":"<b64>","2":"<b64>"}}.
    // Unset: a one-key ring made of PII_ENCRYPTION_KEY / NETPAY_ENCRYPTION_KEY,
    // which also keep reading values written before the keyring existed.
    PII_KEYS_JSON: z
      .string()
      .refine((value) => keyringJsonProblem(value) === null, {
        message: 'PII_KEYS_JSON must be {"current":"<n>","keys":{"<n>":"<base64 32-byte key>"}}.',
      })
      .optional(),
    NETPAY_KEYS_JSON: z
      .string()
      .refine((value) => keyringJsonProblem(value) === null, {
        message: 'NETPAY_KEYS_JSON must be {"current":"<n>","keys":{"<n>":"<base64 32-byte key>"}}.',
      })
      .optional(),

    API_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9]{2,12}$/, 'API_KEY_PREFIX must be 2-12 lowercase alphanumeric characters.')
      .default('mtb'),
    API_KEY_ARGON2_MEMORY_COST: z.coerce.number().int().min(1024).max(1_048_576).default(19_456),
    API_KEY_ARGON2_TIME_COST: z.coerce.number().int().min(1).max(16).default(2),
    API_KEY_DEFAULT_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(90),

    PII_LOG_REDACTION: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
    // GCP project that owns the request traces. Cloud Logging only links a log
    // line to its trace when `logging.googleapis.com/trace` is the full
    // `projects/<id>/traces/<trace>` name; without it the logger emits the bare
    // trace id instead. Cloud Run does not expose the project id to the
    // container, so it is configuration.
    GCP_PROJECT_ID: z
      .string()
      .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'GCP_PROJECT_ID must be a GCP project id.')
      .optional(),

    DOCS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    DOCS_PATH: z.string().min(1).default('docs'),
    DOCS_BASIC_AUTH_USER: z.string().min(1).default('docs'),
    // The API reference is the whole route/DTO map and is served outside the
    // Nest guard chain, so it is also unthrottled. `min(1)` would accept a
    // single-character password, and every other secret in this schema demands
    // far more. There is deliberately no default: the superRefine below requires
    // a real credential whenever DOCS_ENABLED is true, instead of quietly
    // falling back to a value published in `.env.example`.
    DOCS_BASIC_AUTH_PASSWORD: z
      .string()
      .min(16, 'DOCS_BASIC_AUTH_PASSWORD must be at least 16 characters')
      .optional(),
  })
  .superRefine((env, ctx) => {
    // Reusing one secret for both token types lets an attacker mint a refresh
    // token from a leaked access token.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET.',
      });
    }

    // Serving the docs publishes the complete route/DTO surface, and that route
    // chain carries no throttling. A real credential is therefore mandatory
    // whenever the reference is mounted — in every environment, not just
    // production, because `.env.example` ships a known placeholder.
    if (env.DOCS_ENABLED) {
      if (!env.DOCS_BASIC_AUTH_PASSWORD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DOCS_BASIC_AUTH_PASSWORD'],
          message: 'DOCS_BASIC_AUTH_PASSWORD is required when DOCS_ENABLED=true.',
        });
      } else if (env.DOCS_BASIC_AUTH_PASSWORD === 'change-me-docs-password') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DOCS_BASIC_AUTH_PASSWORD'],
          message:
            'DOCS_BASIC_AUTH_PASSWORD still holds the .env.example placeholder; set a real password or DOCS_ENABLED=false.',
        });
      }
    }

    // Row-level security on the tenant tables is only enforced when the data
    // plane connects as a role that is neither the table owner nor a superuser.
    // Falling back to the control-plane credential silently removes that layer,
    // so production refuses to boot without an explicit data-plane credential
    // rather than serving with the isolation quietly degraded.
    if (env.NODE_ENV === 'production' && !env.TENANT_PLANE_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANT_PLANE_DATABASE_URL'],
        message:
          'TENANT_PLANE_DATABASE_URL is required in production. Without it the tenant data plane runs as the provisioning role and row-level security is not enforced.',
      });
    }

    // A checkout created without these would send the buyer to a placeholder
    // host after paying, so production refuses to boot rather than create one.
    if (env.NODE_ENV === 'production') {
      for (const key of ['PAYMENT_REDIRECT_URL', 'PAYMENT_CANCEL_URL'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required in production: hosted checkout cannot return the buyer without it.`,
          });
        }
      }
    }

    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not be "*" in production.',
      });
    }
  });

/** Validated environment type. */
export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env` and returns the nested configuration tree consumed by
 * {@link AppConfig}.
 *
 * @param raw Environment variables, defaults to `process.env`.
 * @returns A nested, typed configuration object.
 * @throws {z.ZodError} When any variable is missing or invalid.
 */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;

  // Production cannot get here without both (superRefine above).
  const paymentUrls = {
    redirectUrl: env.PAYMENT_REDIRECT_URL ?? DEV_PAYMENT_URL_FALLBACK,
    cancelUrl: env.PAYMENT_CANCEL_URL ?? DEV_PAYMENT_URL_FALLBACK,
    quickLinkBaseUrl: env.QUICK_LINK_BASE_URL?.replace(/\/+$/, '') ?? null,
  };
  setPaymentUrls(paymentUrls);

  return {
    app: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      apiPrefix: env.API_PREFIX,
      corsOrigins: env.CORS_ORIGINS,
      apiBaseDomain: env.API_BASE_DOMAIN.toLowerCase(),
      publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
      trustProxyHops: env.TRUST_PROXY_HOPS,
      gcpProjectId: env.GCP_PROJECT_ID,
    },
    database: {
      url: env.CONTROL_PLANE_DATABASE_URL,
      tenantDatabaseUrl: env.TENANT_PLANE_DATABASE_URL ?? env.CONTROL_PLANE_DATABASE_URL,
      tenantClientCacheMax: env.TENANT_CLIENT_CACHE_MAX,
      poolMax: env.DATABASE_POOL_MAX,
      poolIdleTimeoutMs: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    payments: {
      encryptionKey: env.NETPAY_ENCRYPTION_KEY,
      keysJson: env.NETPAY_KEYS_JSON ?? null,
      merchantInitiatedEnabled: env.NETPAY_MIT_ENABLED === 'true',
      ...paymentUrls,
    },
    outboundWebhooks: {
      enabled: env.OUTBOUND_WEBHOOK_ENABLED,
      requireHttps: env.OUTBOUND_WEBHOOK_REQUIRE_HTTPS,
      timeoutMs: env.OUTBOUND_WEBHOOK_TIMEOUT_MS,
      maxAttempts: env.OUTBOUND_WEBHOOK_MAX_ATTEMPTS,
      baseBackoffMs: env.OUTBOUND_WEBHOOK_BASE_BACKOFF_MS,
      maxBackoffMs: env.OUTBOUND_WEBHOOK_MAX_BACKOFF_MS,
      jitterMs: env.OUTBOUND_WEBHOOK_JITTER_MS,
      pollIntervalMs: env.OUTBOUND_WEBHOOK_POLL_INTERVAL_MS,
      batchSize: env.OUTBOUND_WEBHOOK_BATCH_SIZE,
      autoDisableAfter: env.OUTBOUND_WEBHOOK_AUTO_DISABLE_AFTER,
      maxTenantsPerTick: env.OUTBOUND_WEBHOOK_MAX_TENANTS_PER_TICK,
      maxAgeMs: env.OUTBOUND_WEBHOOK_MAX_AGE_HOURS * 3_600_000,
      concurrency: env.OUTBOUND_WEBHOOK_CONCURRENCY,
      allowedCidrs: env.OUTBOUND_WEBHOOK_ALLOWED_CIDRS,
    },
    reconciliation: {
      enabled: env.RECONCILE_ENABLED,
      intervalMs: env.RECONCILE_INTERVAL_MS,
      minAgeMs: env.RECONCILE_MIN_AGE_MS,
      batchSize: env.RECONCILE_BATCH_SIZE,
      threeDsTimeoutMs: env.RECONCILE_THREEDS_TIMEOUT_MS,
      chargeUnknownGraceMs: env.RECONCILE_CHARGE_UNKNOWN_GRACE_MS,
      providerRatePerSecond: env.RECONCILE_NETPAY_RATE_PER_SECOND,
    },
    internalTick: {
      serviceAccountEmail: env.INTERNAL_TICK_SA_EMAIL ?? null,
      audience: env.INTERNAL_TICK_AUDIENCE ?? env.PUBLIC_BASE_URL ?? null,
    },
    auth: {
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      piiHmacKey: env.PII_HMAC_KEY,
      piiEncryptionKey: env.PII_ENCRYPTION_KEY,
      jwtAccessTtl: env.JWT_ACCESS_TTL,
      jwtRefreshTtl: env.JWT_REFRESH_TTL,
      jwtIssuer: env.JWT_ISSUER,
      jwtAudience: env.JWT_AUDIENCE,
      maxFailedAttempts: env.AUTH_MAX_FAILED_ATTEMPTS,
      lockoutDuration: env.AUTH_LOCKOUT_DURATION,
      throttleLimit: env.AUTH_THROTTLE_LIMIT,
      throttleTtl: env.AUTH_THROTTLE_TTL,
      mfaRequiredForAdmins:
        env.MFA_REQUIRED_FOR_ADMINS === undefined
          ? env.NODE_ENV === 'production'
          : env.MFA_REQUIRED_FOR_ADMINS === 'true',
      authzCacheTtlMs: env.AUTHZ_CACHE_TTL_MS,
      piiKeysJson: env.PII_KEYS_JSON ?? null,
    },
    argon2: {
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
    throttle: {
      limit: env.THROTTLE_LIMIT,
      ttl: env.THROTTLE_TTL,
      redisUrl: env.THROTTLER_REDIS_URL ?? null,
    },
    apiKeys: {
      prefix: env.API_KEY_PREFIX,
      memoryCost: env.API_KEY_ARGON2_MEMORY_COST,
      timeCost: env.API_KEY_ARGON2_TIME_COST,
      defaultTtlDays: env.API_KEY_DEFAULT_TTL_DAYS,
    },
    pii: {
      logRedaction: env.PII_LOG_REDACTION,
      logLevel: env.LOG_LEVEL,
    },
    docs: {
      enabled: env.DOCS_ENABLED,
      path: env.DOCS_PATH,
      basicAuthUser: env.DOCS_BASIC_AUTH_USER,
      basicAuthPassword: env.DOCS_BASIC_AUTH_PASSWORD,
    },
  };
}
