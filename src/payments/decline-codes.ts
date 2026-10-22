/**
 * Normalised decline codes (BN-REQ-PAY-006).
 *
 * Netpay reports a refused charge in three ways, depending on the layer that refused
 * it, and none of them is a stable contract a storefront can branch on:
 *
 *  * an issuer answer in the ISO 8583 two-character family (`51` insufficient funds,
 *    `54` expired card, `05` do not honor…), carried in `responseCode`;
 *  * a gateway reason code in the three-digit family Netpay's gateway uses for 3-D
 *    Secure too (`100` accepted, `475` challenge — see `NetpayThreeDSecure`), which is
 *    the CyberSource reason-code table (`481` Decision Manager rejection, `476` payer
 *    authentication failed, `204` insufficient funds…);
 *  * and, for a 409 decline, only a message (`"Rejected by Decision Manager"`, verified
 *    against the sandbox; see docs/NETPAY-INTEGRATION.md).
 *
 * The table below is the union of both code families, with the message as a fallback.
 * Anything unrecognised is `UNKNOWN`; the original code is kept in an internal field
 * (`providerFailureCode`) so a new code can be added here from real traffic.
 */

/** Stable decline codes, in the order they are documented. */
export const DECLINE_CODES = [
  'INSUFFICIENT_FUNDS',
  'CARD_EXPIRED',
  'DO_NOT_HONOR',
  'FRAUD_SUSPECTED',
  'AUTHENTICATION_FAILED',
  'INVALID_CARD',
  'LIMIT_EXCEEDED',
  'PROCESSOR_ERROR',
  'UNKNOWN',
] as const;

/** A stable decline code. */
export type DeclineCode = (typeof DECLINE_CODES)[number];

/** Issuer (ISO 8583) and gateway reason codes, by the stable code they mean. */
const CODE_TABLE: Readonly<Record<Exclude<DeclineCode, 'UNKNOWN'>, readonly string[]>> = {
  INSUFFICIENT_FUNDS: ['51', '204'],
  CARD_EXPIRED: ['33', '54', '202'],
  DO_NOT_HONOR: ['01', '02', '05', '12', '57', '62', '203', '233'],
  FRAUD_SUSPECTED: ['04', '07', '34', '41', '43', '59', '63', '205', '400', '481', '520'],
  AUTHENTICATION_FAILED: ['476', '478'],
  INVALID_CARD: ['14', '15', '56', '82', 'N7', '211', '231', '232'],
  LIMIT_EXCEEDED: ['61', '65', '121', '210'],
  PROCESSOR_ERROR: ['06', '19', '91', '92', '94', '96', '150', '151', '152', '236', '250'],
};

/** Reverse index of {@link CODE_TABLE}. */
const BY_CODE: ReadonlyMap<string, DeclineCode> = new Map(
  (Object.entries(CODE_TABLE) as [DeclineCode, readonly string[]][]).flatMap(([code, raws]) =>
    raws.map((raw) => [raw, code] as const),
  ),
);

/**
 * Message fallbacks, tried in order, for declines that carry no code.
 *
 * Spanish and English, without accents (Netpay's own messages come both ways).
 */
const MESSAGE_RULES: readonly (readonly [RegExp, DeclineCode])[] = [
  [/decision manager|fraud|fraude|riesgo|robad|stolen|lost card|extraviad/, 'FRAUD_SUSPECTED'],
  [/insufficient|insuficiente|fondos/, 'INSUFFICIENT_FUNDS'],
  [/expired|expirad|vencid/, 'CARD_EXPIRED'],
  [/3ds|3-d secure|authenticat|autentica/, 'AUTHENTICATION_FAILED'],
  [/limit|limite|exceed|excede/, 'LIMIT_EXCEEDED'],
  [/invalid (card|token)|token invalid|tarjeta invalida|card number|cvv|numero de tarjeta/, 'INVALID_CARD'],
  [/timeout|time out|processor|procesador|system error|error de sistema/, 'PROCESSOR_ERROR'],
  [/do not honor|no honrar|declin|rechaz|reject|denegad/, 'DO_NOT_HONOR'],
];

/** What a classification yields. */
export interface DeclineClassification {
  /** Stable code, safe to show to a storefront and to put in an event. */
  readonly failureCode: DeclineCode;
  /** Netpay's own code, kept internally; `null` when absent or not a short code. */
  readonly providerCode: string | null;
}

/**
 * Normalises a Netpay decline.
 *
 * @param input The provider's code (`responseCode`) and message, when present.
 * @returns The stable code and the original code.
 */
export function classifyDecline(input: {
  readonly code?: string | number | null;
  readonly message?: string | null;
}): DeclineClassification {
  const providerCode = normaliseCode(input.code);
  const byCode = providerCode === null ? undefined : BY_CODE.get(providerCode);
  if (byCode !== undefined) {
    return { failureCode: byCode, providerCode };
  }
  const message = (input.message ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const byMessage = message === '' ? undefined : MESSAGE_RULES.find(([pattern]) => pattern.test(message));
  return { failureCode: byMessage?.[1] ?? 'UNKNOWN', providerCode };
}

/**
 * Turns a raw code into the form the table uses.
 *
 * A number below 100 is an issuer code and is zero-padded (`5` → `05`). Anything
 * that is not a short alphanumeric code is dropped rather than kept, so a stray
 * value (a card number in the wrong field) can never be persisted as a "code".
 *
 * @param code Raw code.
 * @returns The normalised code, or `null`.
 */
function normaliseCode(code: string | number | null | undefined): string | null {
  if (code === null || code === undefined) {
    return null;
  }
  if (typeof code === 'number') {
    if (!Number.isInteger(code) || code < 0 || code > 9999) {
      return null;
    }
    return code < 100 ? String(code).padStart(2, '0') : String(code);
  }
  const text = code.trim().toUpperCase();
  return /^[A-Z0-9]{1,4}$/.test(text) ? text : null;
}
