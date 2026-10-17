import { createHmac, timingSafeEqual } from 'node:crypto';

/** Version tag sent on every delivery. */
export const SIGNATURE_VERSION = 'v1';

/** Header carrying the signature. */
export const SIGNATURE_HEADER = 'x-mtbpay-signature';

/** Default clock-skew tolerance, in milliseconds. */
export const DEFAULT_TOLERANCE_MS = 300_000;

/** A payload ready to be signed and sent. */
export interface SignedEnvelope {
  readonly headers: Record<string, string>;
  readonly body: string;
  /** Unix seconds the signature covers. */
  readonly timestamp: number;
}

/**
 * Signs an outbound delivery.
 *
 * The signature covers `<timestamp>.<raw body>`. Binding the timestamp is what
 * lets a receiver reject a captured delivery replayed later, and signing the raw
 * body — rather than a re-serialisation of the parsed object — is what makes
 * the receiver's check meaningful.
 *
 * @param secret The subscriber's signing secret.
 * @param body Exact JSON body to send.
 * @param timestamp Unix seconds; supplied by the caller so tests can pin it.
 * @returns Headers to merge into the request.
 */
export function signDelivery(secret: string, body: string, timestamp: number): Record<string, string> {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return { [SIGNATURE_HEADER]: `t=${timestamp},${SIGNATURE_VERSION}=${signature}` };
}

/** Outcome of verifying a delivery. */
export type VerificationOutcome =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'STALE' | 'MISMATCH' };

/**
 * Verifies a delivery exactly as a subscriber should.
 *
 * Documented verbatim for integrators, because getting the order wrong is the
 * usual reason a signature check is useless.
 *
 * @param header Value of the signature header.
 * @param rawBody Exact body bytes received.
 * @param secret The subscriber's secret.
 * @param nowMs Current time, injected so tests are deterministic.
 * @param toleranceMs Acceptable clock skew.
 * @returns Whether the delivery is authentic and fresh.
 */
export function verifyDelivery(
  header: string,
  rawBody: string,
  secret: string,
  nowMs: number,
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): VerificationOutcome {
  const parts = header.split(',');
  const timestampRaw = parts.find((p) => p.startsWith('t='))?.slice(2);
  // There may be more than one signature: during a secret rotation the delivery
  // carries the current and the previous one, so a subscriber holding either must
  // accept it. Every candidate is tried before the delivery is refused.
  const signatures = parts
    .filter((p) => p.startsWith(`${SIGNATURE_VERSION}=`))
    .map((p) => p.slice(SIGNATURE_VERSION.length + 1));
  if (timestampRaw === undefined || signatures.length === 0) {
    return { valid: false, reason: 'MALFORMED' };
  }
  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: 'MALFORMED' };
  }
  const age = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (age * 1000 > toleranceMs) {
    return { valid: false, reason: 'STALE' };
  }
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex'),
    'utf8',
  );
  for (const candidate of signatures) {
    const provided = Buffer.from(candidate, 'utf8');
    // Constant-time compare, and only between equal lengths.
    if (provided.length === expected.length && timingSafeEqual(expected, provided)) {
      return { valid: true };
    }
  }
  return { valid: false, reason: 'MISMATCH' };
}

/**
 * The standard headers every delivery carries.
 *
 * @param eventId Stable across retries.
 * @param eventType Event name.
 * @param attempt 1-based attempt counter.
 * @returns Header map.
 */
export function deliveryHeaders(eventId: string, eventType: string, attempt: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-mtbpay-event-id': eventId,
    'x-mtbpay-event-type': eventType,
    'x-mtbpay-attempt': String(attempt),
    'x-mtbpay-delivery': SIGNATURE_VERSION,
  };
}

/**
 * Builds the JSON body for an event, with a stable field order.
 *
 * @param eventId Stable event id.
 * @param eventType Event name.
 * @param occurredAt ISO timestamp.
 * @param sequence Per-resource counter, so a subscriber can spot a gap.
 * @param tenantId Tenant the event belongs to.
 * @param data Event payload.
 * @returns The exact body string to sign and send.
 */
export function buildEventBody(
  eventId: string,
  eventType: string,
  occurredAt: string,
  sequence: number,
  tenantId: string,
  data: Record<string, unknown>,
): string {
  return JSON.stringify({ eventId, eventType, occurredAt, sequence, tenantId, data });
}
