import { Injectable } from '@nestjs/common';

/**
 * Object keys whose values must never reach a log sink.
 *
 * Matching is case-insensitive and substring based, so `customerEmail` and
 * `user_email_address` are both caught.
 */
const REDACTED_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'credential',
  'cookie',
  'session',
  'ssn',
  'taxid',
  'creditcard',
  'cardnumber',
  'cvv',
  'iban',
  'pin',
  'otp',
  'privatekey',
  'encryptionkey',
  'hmackey',
] as const;

/** Keys that are safe to log verbatim even though they match a pattern. */
const ALLOWLISTED_KEYS = new Set([
  'authorization_scheme',
  'token_expires_at',
  'token_type',
  'api_key_prefix',
  'has_password',
  'auth_method',
]);

/** Placeholder substituted for redacted values. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Recursively scrubs PII and credentials from arbitrary values before logging.
 *
 * The scrubber runs on every log payload when `PII_LOG_REDACTION` is enabled, so
 * an accidental `logger.debug(dto)` cannot leak a password or an access token.
 * It is deliberately conservative: it strips whole objects rather than trying
 * to guess which fields are safe, because over-redaction is cheap while
 * under-redaction is a breach.
 */
@Injectable()
export class PiiRedactionService {
  private readonly enabled: boolean;

  /**
   * @param enabled When `false`, values pass through untouched. Only useful in
   * a tightly controlled debugging session.
   */
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * Reports whether redaction is active.
   *
   * @returns `true` when {@link PiiRedactionService.scrub} replaces values.
   */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Deep-copies a value, replacing sensitive fields with a placeholder.
   *
   * Handles nested objects, arrays, `Map`, `Set`, `Date`, `Buffer`, `Error` and
   * cyclic references. Class instances are flattened to plain objects so
   * getters with side effects are not triggered.
   *
   * @param value Value to scrub.
   * @returns The scrubbed copy.
   */
  scrub<T>(value: T): T {
    if (!this.enabled) {
      return value;
    }
    return this.scrubValue(value, new WeakSet<object>()) as T;
  }

  /**
   * Scrubs a value and renders it as a compact JSON string.
   *
   * @param value Value to render.
   * @returns JSON representation with sensitive fields redacted.
   */
  scrubToJson(value: unknown): string {
    try {
      return JSON.stringify(this.scrub(value));
    } catch {
      return '"[UNSERIALISABLE]"';
    }
  }

  /**
   * Redacts an e-mail address that appears inside free text, such as an error
   * message produced by a downstream library.
   *
   * @param message Message to scan.
   * @returns The message with e-mail addresses replaced.
   */
  scrubMessage(message: string): string {
    if (!this.enabled || !message) {
      return message;
    }
    return message.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (match) => `${match.slice(0, 1)}***@${match.split('@')[1]}`,
    );
  }

  /**
   * Recursive worker for {@link PiiRedactionService.scrub}.
   *
   * @param value Current node.
   * @param seen Objects already visited, used to break cycles.
   * @returns The scrubbed node.
   */
  private scrubValue(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    const type = typeof value;
    if (type === 'string') {
      return value;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
      return value;
    }
    if (type === 'function' || type === 'symbol') {
      return `[${type}]`;
    }

    const asObject = value;
    if (seen.has(asObject)) {
      return '[Circular]';
    }
    seen.add(asObject);

    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: this.scrubValue(value.name, seen),
        message: this.scrubMessage(value.message),
        ...(value.cause !== undefined ? { cause: this.scrubValue(value.cause, seen) } : {}),
      };
    }
    if (Buffer.isBuffer(value)) {
      return `[Buffer ${value.length} bytes]`;
    }
    if (value instanceof Map) {
      // Map keys are property names too, so a `Map(['password', secret])` must be
      // redacted just like an object with the same shape.
      return Object.fromEntries(
        [...value.entries()].map(([key, entry]) => [
          String(key),
          this.shouldRedact(String(key)) ? REDACTED_PLACEHOLDER : this.scrubValue(entry, seen),
        ]),
      );
    }
    if (value instanceof Set) {
      return [...value.values()].map((entry) => this.scrubValue(entry, seen));
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.scrubValue(entry, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = this.shouldRedact(key) ? REDACTED_PLACEHOLDER : this.scrubValue(entry, seen);
    }
    return output;
  }

  /**
   * Decides whether a property name must be redacted.
   *
   * @param key Property name.
   * @returns `true` when the value must be replaced.
   */
  private shouldRedact(key: string): boolean {
    const normalized = key.toLowerCase();
    if (ALLOWLISTED_KEYS.has(normalized)) {
      return false;
    }
    return REDACTED_KEYS.some((needle) => normalized.includes(needle));
  }
}
