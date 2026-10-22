import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) and recovery codes for platform administrators
 * (BN-REQ-SEC-006).
 *
 * HMAC-SHA1, 6 digits, 30-second steps: the parameters every authenticator app
 * supports. Implemented on `node:crypto` rather than a library because the
 * whole algorithm is a dozen lines and the RFC test vectors pin it down.
 */

/** Seconds per TOTP step. */
export const TOTP_PERIOD_SECONDS = 30;

/** Steps of clock drift tolerated either side of now. */
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encodes bytes as unpadded RFC 4648 base32.
 *
 * @param data Bytes to encode.
 * @returns Base32 text.
 */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decodes RFC 4648 base32, ignoring case, spaces and padding.
 *
 * @param text Base32 text.
 * @returns The bytes.
 * @throws {Error} On a character outside the alphabet.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character.');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generates a 160-bit TOTP secret.
 *
 * @returns The raw secret.
 */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/**
 * Computes the 6-digit code for one time step.
 *
 * @param secret Raw shared secret.
 * @param step `floor(unixSeconds / 30)`.
 * @returns Zero-padded code.
 */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Verifies a code within ±1 step, refusing replays.
 *
 * @param secret Raw shared secret.
 * @param code Submitted code.
 * @param nowMs Current time, epoch milliseconds.
 * @param lastUsedStep Step of the last accepted code; codes at or before it are refused.
 * @returns The matched step, or `null`.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  const submitted = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(submitted)) {
    return null;
  }
  const current = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) {
      continue;
    }
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(submitted))) {
      return step;
    }
  }
  return null;
}

/**
 * Builds the `otpauth://` provisioning URI (rendered as a QR code by clients).
 *
 * @param secretBase32 Base32 secret.
 * @param account Account label; the masked e-mail, never the plaintext.
 * @param issuer Issuer label.
 * @returns The URI.
 */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD_SECONDS}`;
}

/**
 * Generates ten single-use recovery codes, 50 bits each.
 *
 * @returns Codes formatted `XXXXX-XXXXX`.
 */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < 10) {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/**
 * Hashes a recovery code for storage, after normalising case and separators.
 *
 * SHA-256 suffices: the codes are random, not human-chosen, and attempts are
 * throttled and lock the account like a wrong password.
 *
 * @param code Recovery code as typed.
 * @returns Hex digest.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, ''), 'utf8').digest('hex');
}
