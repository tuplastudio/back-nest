import { z } from 'zod';

/**
 * Placeholder used for the checkout redirect and cancel URLs outside
 * production, so local and test environments boot without inventing a domain.
 * Production refuses to start without real values (`env.validation.ts`).
 */
export const DEV_PAYMENT_URL_FALLBACK = 'https://localhost/';

/** Where Netpay sends the buyer after a hosted checkout. */
export interface PaymentUrls {
  /** Return URL after a completed checkout. */
  readonly redirectUrl: string;
  /** Return URL after the buyer abandons the checkout. */
  readonly cancelUrl: string;
}

/**
 * Field rules, shared by the boot-time schema in `env.validation.ts` and the
 * lazy fallback below, so both paths accept exactly the same values.
 */
export const paymentUrlFields = {
  PAYMENT_REDIRECT_URL: z.string().url('PAYMENT_REDIRECT_URL must be an absolute URL.').optional(),
  PAYMENT_CANCEL_URL: z.string().url('PAYMENT_CANCEL_URL must be an absolute URL.').optional(),
};

let current: PaymentUrls | null = null;

/**
 * Records the validated URLs. Called by `validateEnv` once the whole
 * environment has passed the schema.
 *
 * @param urls Validated URLs.
 */
export function setPaymentUrls(urls: PaymentUrls): void {
  current = { ...urls };
}

/**
 * The validated checkout URLs.
 *
 * Payment code reads them here instead of from `process.env` (BN-REQ-CFG-006):
 * the values have passed the same Zod rules as the rest of the configuration
 * and production cannot reach this point without them. A process that never
 * ran `validateEnv` (a unit test building a service by hand) validates the
 * two variables on first use with the same rules.
 *
 * @returns Redirect and cancel URLs.
 * @throws {Error} When the variables are invalid, or missing in production.
 */
export function paymentUrls(): PaymentUrls {
  if (current) {
    return current;
  }
  const parsed = z.object(paymentUrlFields).safeParse(process.env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  if (process.env['NODE_ENV'] === 'production') {
    for (const key of ['PAYMENT_REDIRECT_URL', 'PAYMENT_CANCEL_URL'] as const) {
      if (!parsed.data[key]) {
        throw new Error(`${key} is required in production.`);
      }
    }
  }
  // Not cached: without a boot-time snapshot the environment is the source,
  // and a test that changes it between cases must see the change.
  return {
    redirectUrl: parsed.data.PAYMENT_REDIRECT_URL ?? DEV_PAYMENT_URL_FALLBACK,
    cancelUrl: parsed.data.PAYMENT_CANCEL_URL ?? DEV_PAYMENT_URL_FALLBACK,
  };
}

/** Clears the recorded URLs. Tests only. */
export function resetPaymentUrlsForTesting(): void {
  current = null;
}
