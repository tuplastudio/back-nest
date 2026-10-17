import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';

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
 * `iv (12 bytes) || authTag (16 bytes) || ciphertext`, base64url encoded.
 */
export class PaymentSecretBox {
  private readonly key: Buffer;

  /**
   * @param base64Key Base64 encoded key of exactly 32 bytes.
   * @throws {Error} When the key is not exactly 32 bytes.
   */
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('Payment encryption key must decode to exactly 32 bytes.');
    }
  }

  /**
   * Encrypts a secret for storage.
   *
   * @param plaintext Secret, e.g. `sk_netpay_…`.
   * @param aad Additional authenticated data binding the value to its context.
   * @returns base64url ciphertext.
   */
  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /**
   * Decrypts a stored secret.
   *
   * @param ciphertext base64url ciphertext produced by {@link encrypt}.
   * @param aad Must match the value used when encrypting.
   * @returns The plaintext secret.
   * @throws {Error} When the ciphertext or AAD is wrong.
   */
  decrypt(ciphertext: string, aad: string): string {
    const raw = Buffer.from(ciphertext, 'base64url');
    if (raw.length < 28) {
      throw new Error('Ciphertext is too short to be valid.');
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
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
