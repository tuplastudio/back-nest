import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Raised when a keyring cannot be built or a value cannot be decrypted.
 *
 * Decryption messages never say *why* (unknown version, wrong key, tampering):
 * answering would turn the helper into an oracle.
 */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** `v<n>:` — base64url never contains `:`, so legacy values cannot match. */
const VERSION_PATTERN = /^v([1-9]\d{0,5}):(.*)$/s;

/**
 * Versioned AES-256-GCM keyring (BN-REQ-SEC-007).
 *
 * Format
 * ------
 * `v<n>:` + base64url(`nonce(12) || tag(16) || body`). The prefix names the key
 * that wrote the value, so a rotation is: add key `n+1`, make it current, run
 * the re-encryption job, retire key `n` once the job reports nothing left.
 *
 * Values written before the keyring existed carry no prefix. They are read with
 * the *legacy* key — the single key the deployment used until now
 * (`PII_ENCRYPTION_KEY` / `NETPAY_ENCRYPTION_KEY`) — so rolling this out needs
 * no data migration.
 *
 * Configuration (`PII_KEYS_JSON`, `NETPAY_KEYS_JSON`):
 * `{"current":"2","keys":{"1":"<base64 32 bytes>","2":"<base64 32 bytes>"}}`.
 * Wrapping the data keys with Cloud KMS is an infrastructure follow-up; the
 * ring only ever sees unwrapped key bytes.
 */
export class Keyring {
  private constructor(
    /** Version new values are written with. */
    readonly currentVersion: string,
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly legacyKey: Buffer | null,
  ) {}

  /**
   * A one-key ring: version 1 is the existing key, which also reads legacy values.
   *
   * @param base64Key Base64 encoded 32-byte key.
   * @returns The keyring.
   */
  static single(base64Key: string): Keyring {
    const key = decodeKey(base64Key, 'the encryption key');
    return new Keyring('1', new Map([['1', key]]), key);
  }

  /**
   * Parses `{current, keys}` JSON.
   *
   * @param json Keyring JSON.
   * @param legacyBase64Key Key that reads unprefixed (pre-keyring) values, if any.
   * @returns The keyring.
   * @throws {KeyringError} When the JSON or a key is malformed.
   */
  static fromJson(json: string, legacyBase64Key?: string): Keyring {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new KeyringError('Keyring JSON is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new KeyringError('Keyring JSON must be an object {"current": "...", "keys": {...}}.');
    }
    const { current, keys } = parsed as { current?: unknown; keys?: unknown };
    if (typeof current !== 'string' || typeof keys !== 'object' || keys === null) {
      throw new KeyringError('Keyring JSON must be an object {"current": "...", "keys": {...}}.');
    }
    const map = new Map<string, Buffer>();
    for (const [id, value] of Object.entries(keys as Record<string, unknown>)) {
      if (!/^[1-9]\d{0,5}$/.test(id)) {
        throw new KeyringError(`Keyring key id "${id}" must be a positive integer.`);
      }
      if (typeof value !== 'string') {
        throw new KeyringError(`Keyring key "${id}" must be a base64 string.`);
      }
      map.set(id, decodeKey(value, `keyring key "${id}"`));
    }
    if (!map.has(current)) {
      throw new KeyringError(`Keyring current version "${current}" is not one of its keys.`);
    }
    const legacy = legacyBase64Key === undefined ? null : decodeKey(legacyBase64Key, 'the legacy key');
    return new Keyring(current, map, legacy);
  }

  /**
   * Reads the key version a value was written with.
   *
   * @param payload Stored value.
   * @returns The version, or `null` for a legacy (unprefixed) value.
   */
  static versionOf(payload: string): string | null {
    return VERSION_PATTERN.exec(payload)?.[1] ?? null;
  }

  /**
   * @param payload Stored value.
   * @returns `true` when it was written with the current key.
   */
  isCurrent(payload: string): boolean {
    return Keyring.versionOf(payload) === this.currentVersion;
  }

  /**
   * Encrypts with the current key.
   *
   * @param plaintext Value to protect.
   * @param aad Additional authenticated data.
   * @returns `v<current>:<base64url>`.
   */
  encrypt(plaintext: string, aad?: string): string {
    const key = this.keys.get(this.currentVersion) as Buffer;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    if (aad) {
      cipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v${this.currentVersion}:${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  /**
   * Decrypts a value written by any key in the ring, or a legacy value.
   *
   * @param payload Stored value.
   * @param aad Must repeat the AAD used when encrypting.
   * @returns The plaintext.
   * @throws {KeyringError} When the value cannot be decrypted.
   */
  decrypt(payload: string, aad?: string): string {
    const match = VERSION_PATTERN.exec(payload);
    const key = match ? this.keys.get(match[1]) : this.legacyKey;
    const encoded = match ? match[2] : payload;
    if (!key) {
      throw new KeyringError('Unable to decrypt value.');
    }
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.length < NONCE_BYTES + TAG_BYTES) {
      throw new KeyringError('Ciphertext is too short to be valid.');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, NONCE_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      if (aad) {
        decipher.setAAD(Buffer.from(aad, 'utf8'));
      }
      return Buffer.concat([
        decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new KeyringError('Unable to decrypt value: authentication failed.');
    }
  }
}

/**
 * Decodes and length-checks a base64 key.
 *
 * @param base64 Encoded key.
 * @param label Name for the error message.
 * @returns The key bytes.
 */
function decodeKey(base64: string, label: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new KeyringError(`${label} must decode to exactly ${KEY_BYTES} bytes, received ${key.length}.`);
  }
  return key;
}

/**
 * Validates keyring JSON without keeping the keys, for env validation.
 *
 * @param json Keyring JSON.
 * @returns `null` when valid, otherwise the reason.
 */
export function keyringJsonProblem(json: string): string | null {
  try {
    Keyring.fromJson(json);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
