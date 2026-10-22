import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Keyring } from '../pii/keyring';

/**
 * Encryption for payment credentials.
 *
 * Deliberately separate from `PiiCryptoService`. A Netpay secret key can move
 * money; personal data cannot. Keeping them apart means compromising one does
 * not hand over the other, and each has its own rotation schedule: rotating the
 * PII key already invalidates every blind index, so folding a third rotation
 * into it would couple two unrelated operations.
 *
 * Format, mirroring the PII service so the codebase stays consistent:
 * `v<n>:` + base64url(`iv (12 bytes) || authTag (16 bytes) || ciphertext`), where
 * `n` is the {@link Keyring} version (BN-REQ-SEC-007). Values written before the
 * keyring have no prefix and are read with `NETPAY_ENCRYPTION_KEY`.
 */
export class PaymentSecretBox {
  /** Versioned payment data keys. */
  readonly keyring: Keyring;

  /**
   * @param keys Base64 encoded key of exactly 32 bytes (a one-key ring), or a
   * versioned {@link Keyring} built from `NETPAY_KEYS_JSON`.
   * @throws {Error} When the key is not exactly 32 bytes.
   */
  constructor(keys: string | Keyring) {
    if (typeof keys === 'string') {
      try {
        this.keyring = Keyring.single(keys);
      } catch {
        throw new Error('Payment encryption key must decode to exactly 32 bytes.');
      }
    } else {
      this.keyring = keys;
    }
  }

  /**
   * Builds the box from configuration.
   *
   * @param legacyBase64Key `NETPAY_ENCRYPTION_KEY`: the one-key ring when no
   * keyring JSON is set, and the reader of unprefixed values either way.
   * @param keysJson `NETPAY_KEYS_JSON`, or `null`.
   * @returns The secret box.
   */
  static fromConfig(legacyBase64Key: string, keysJson: string | null): PaymentSecretBox {
    return new PaymentSecretBox(keysJson ? Keyring.fromJson(keysJson, legacyBase64Key) : legacyBase64Key);
  }

  /**
   * Encrypts a secret for storage with the current key.
   *
   * @param plaintext Secret, e.g. `sk_netpay_…`.
   * @param aad Additional authenticated data binding the value to its context.
   * @returns Versioned ciphertext.
   */
  encrypt(plaintext: string, aad: string): string {
    return this.keyring.encrypt(plaintext, aad);
  }

  /**
   * Decrypts a stored secret written by any key in the ring, or a legacy value.
   *
   * @param ciphertext Ciphertext produced by {@link encrypt}.
   * @param aad Must match the value used when encrypting.
   * @returns The plaintext secret.
   * @throws {Error} When the ciphertext or AAD is wrong.
   */
  decrypt(ciphertext: string, aad: string): string {
    return this.keyring.decrypt(ciphertext, aad);
  }

  /**
   * Hashes an opaque token for storage, so the stored value is not a credential.
   *
   * Used for the inbound webhook token: it only ever has to be compared, never
   * used to sign. The outbound webhook secret is the opposite case and is
   * encrypted instead.
   *
   * @param token Opaque token.
   * @returns Hex SHA-256 digest.
   */
  static hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Compares two hashes without leaking their contents through timing.
   *
   * @param a Left hash.
   * @param b Right hash.
   * @returns `true` when equal.
   */
  static hashesMatch(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Generates an opaque, unguessable token.
   *
   * @returns A URL-safe token.
   */
  static generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Generates the signing secret handed to an outbound subscriber.
   *
   * Prefixed so it is recognisable in a receiver's configuration and in a log
   * of a leaked secret, without needing to guess.
   *
   * @returns A signing secret.
   */
  static generateSigningSecret(): string {
    return `whsec_${randomBytes(32).toString('base64url')}`;
  }

  /**
   * Builds the additional authenticated data for a tenant's secret key.
   *
   * Binding the ciphertext to the tenant means a row copied between tenants
   * fails to decrypt instead of silently working.
   *
   * @param tenantId Tenant the key belongs to.
   * @returns AAD string.
   */
  static aadForConfig(tenantId: string): string {
    return `netpay:config:${tenantId}`;
  }

  /**
   * Builds the additional authenticated data for an outbound endpoint secret.
   *
   * @param endpointId Endpoint the secret belongs to.
   * @returns AAD string.
   */
  static aadForEndpoint(endpointId: string): string {
    return `webhook:endpoint:${endpointId}`;
  }
}

/**
 * Generates a reference Netpay can echo back, unique per tenant.
 *
 * @param prefix Tenant-specific prefix from its configuration.
 * @returns A fresh reference.
 */
export function buildOrderReference(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  return `${safePrefix}_${randomUUID().replace(/-/g, '')}`;
}
