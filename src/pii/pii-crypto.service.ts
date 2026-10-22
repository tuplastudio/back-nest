import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Keyring } from './keyring';

/**
 * Raised when a cryptographic operation cannot be completed.
 *
 * Messages deliberately avoid stating *why* a decryption failed: whether the key
 * is wrong or the payload was tampered with is not the caller's business, and
 * answering the question turns the helper into a decryption oracle.
 */
export class PiiCryptoError extends Error {
  /**
   * @param message Safe explanation.
   */
  constructor(message: string) {
    super(message);
    this.name = 'PiiCryptoError';
  }
}

/**
 * Options accepted by {@link PiiCryptoService.encrypt}.
 */
export interface EncryptOptions {
  /**
   * Additional authenticated data.
   *
   * Binds a ciphertext to a logical column, so a value moved from `email` to
   * `phone` fails to decrypt instead of silently decrypting.
   */
  aad?: string;
}

/**
 * Versioned, authenticated encryption for personally identifiable information,
 * plus keyed blind indexes for equality lookups.
 *
 * Design notes
 * ------------
 * * **AES-256-GCM** gives confidentiality and integrity in one primitive. Each
 *   ciphertext carries a fresh 96-bit nonce and a 128-bit authentication tag.
 * * **Ciphertexts are not deterministic.** Two identical e-mail addresses
 *   therefore produce different ciphertexts, so an attacker with read access to
 *   the database cannot spot duplicate records by comparing bytes.
 * * **Lookups need equality**, so they use {@link PiiCryptoService.blindIndex}:
 *   a keyed HMAC-SHA256. It is deterministic within a deployment, keeping
 *   `WHERE emailLookup = $1` a plain indexed comparison, but it is not invertible
 *   without the key.
 * * **Purpose-specific keys are derived** from the configured secrets with
 *   distinct domain labels, so the blind-index key and the encryption key can
 *   never be confused with one another, and a compromised index key does not
 *   decrypt anything.
 *
 * Storage layout
 * --------------
 * The stored value is `v<n>:` followed by base64url of
 * `nonce || authTag || ciphertext`, where `n` is the {@link Keyring} version
 * that wrote it (BN-REQ-SEC-007). Values written before the keyring carry no
 * prefix and are read with the original `PII_ENCRYPTION_KEY`:
 *
 * ```text
 * +--------+-----------+------------+
 * | nonce  |  authTag  | ciphertext |
 * | 12 B   |   16 B    |    n B     |
 * +--------+-----------+------------+
 * ```
 */
@Injectable()
export class PiiCryptoService {
  /** Domain-separation labels. Changing one invalidates existing values. */
  private static readonly INFO_BLIND_INDEX = 'pii:blind-index:v1';
  private static readonly INFO_IP = 'pii:ip:v1';

  /** Versioned data keys. */
  readonly keyring: Keyring;
  private readonly blindIndexKey: Buffer;
  private readonly ipHashKey: Buffer;

  /**
   * @param rootSecret Secret from which purpose-specific keys are derived.
   * @param encryption Base64 encoded 32-byte key (a one-key ring, backward
   * compatible) or a versioned {@link Keyring} built from `PII_KEYS_JSON`.
   * @throws {PiiCryptoError} When the key is not exactly 32 bytes.
   */
  constructor(rootSecret: string, encryption: string | Keyring) {
    this.blindIndexKey = this.deriveKey(rootSecret, PiiCryptoService.INFO_BLIND_INDEX);
    this.ipHashKey = this.deriveKey(rootSecret, PiiCryptoService.INFO_IP);
    try {
      this.keyring = typeof encryption === 'string' ? Keyring.single(encryption) : encryption;
    } catch (error) {
      throw new PiiCryptoError(
        `PII_ENCRYPTION_KEY is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Normalises a value before hashing it.
   *
   * Normalisation is what makes lookups work: `Ada@Example.com` and
   * `ada@example.com` must produce the same blind index, otherwise the same
   * address could be registered twice.
   *
   * @param value Raw input.
   * @returns Trimmed, lower-cased value.
   */
  static normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  /**
   * Normalises an e-mail address for storage and lookup.
   *
   * @param email Raw address.
   * @returns Trimmed, lower-cased address.
   */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Encrypts a value with AES-256-GCM.
   *
   * @param plaintext Value to protect.
   * @param options Optional additional authenticated data.
   * @returns `v<n>:` + base64url encoded `nonce || authTag || ciphertext`.
   * @throws {PiiCryptoError} When the value is empty or not a string.
   */
  encrypt(plaintext: string, options: EncryptOptions = {}): string {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new PiiCryptoError('Cannot encrypt an empty or non-string value.');
    }

    return this.keyring.encrypt(plaintext, options.aad);
  }

  /**
   * Decrypts a value produced by {@link PiiCryptoService.encrypt}.
   *
   * @param payload Base64url encoded payload.
   * @param options Must repeat the same AAD used during encryption.
   * @returns The original plaintext.
   * @throws {PiiCryptoError} When the payload is malformed, truncated, or the
   * authentication tag does not verify.
   */
  decrypt(payload: string, options: EncryptOptions = {}): string {
    if (typeof payload !== 'string' || payload.length === 0) {
      throw new PiiCryptoError('Cannot decrypt an empty or non-string payload.');
    }

    try {
      return this.keyring.decrypt(payload, options.aad);
    } catch {
      // Never surface the crypto reason: it would leak whether the payload
      // existed or which key was used.
      throw new PiiCryptoError('Unable to decrypt value: authentication failed.');
    }
  }

  /**
   * Computes the deterministic blind index used for equality lookups.
   *
   * The value is normalised first, so callers do not need to remember to
   * lower-case e-mail addresses.
   *
   * @param value Value to index, e.g. an e-mail address.
   * @returns 64 character hex string, suitable for a `VARCHAR(64)` column.
   */
  blindIndex(value: string): string {
    return this.hmacHex(this.blindIndexKey, PiiCryptoService.normalize(value));
  }

  /**
   * Computes a keyed hash of an IP address.
   *
   * IP addresses are personal data under GDPR, so the audit trail stores this
   * keyed hash instead of the address: it supports abuse investigation and
   * correlation without persisting the identifier in clear text.
   *
   * @param ip IPv4 or IPv6 address, or `null`.
   * @returns 64 character hex string, or `null`.
   */
  hashIp(ip: string | null | undefined): string | null {
    if (!ip) {
      return null;
    }
    return this.hmacHex(this.ipHashKey, ip.trim().toLowerCase());
  }

  /**
   * Computes an unkeyed SHA-256 digest.
   *
   * Used for values that are not PII but must still not be readable in the
   * database: refresh tokens and user agents. Both are high-entropy or
   * non-identifying, so a fast hash is appropriate and keeps latency low.
   *
   * @param value Input string.
   * @returns 64 character hex digest.
   */
  static sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /**
   * Compares two strings in constant time.
   *
   * @param a First value.
   * @param b Second value.
   * @returns `true` when both are byte-identical.
   */
  static safeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
      // Still run a comparison to keep the timing profile flat.
      timingSafeEqual(bufferA, bufferA);
      return false;
    }
    return timingSafeEqual(bufferA, bufferB);
  }

  /**
   * Derives a 32-byte key from a root secret and a domain label.
   *
   * @param secret Root secret.
   * @param info Domain separation label.
   * @returns The derived 32-byte key.
   */
  private deriveKey(secret: string, info: string): Buffer {
    return createHmac('sha256', secret).update(info, 'utf8').digest();
  }

  /**
   * HMAC helper returning a hex digest.
   *
   * @param key Derived key.
   * @param value Message to authenticate.
   * @returns Hex encoded digest.
   */
  private hmacHex(key: Buffer, value: string): string {
    return createHmac('sha256', key).update(value, 'utf8').digest('hex');
  }
}
