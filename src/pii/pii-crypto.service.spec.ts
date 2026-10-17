import { randomBytes } from 'node:crypto';
import { PiiCryptoError, PiiCryptoService } from './pii-crypto.service';

/**
 * Tests for the PII cryptographic primitives.
 *
 * These assertions encode the properties the rest of the system relies on:
 * ciphertexts are non-deterministic, blind indexes are deterministic and
 * case-insensitive, and tampering is detected.
 */
describe('PiiCryptoService', () => {
  const rootSecret = 'a-root-secret-for-tests-only';
  const encodingKey = randomBytes(32).toString('base64');

  let service: PiiCryptoService;

  beforeEach(() => {
    service = new PiiCryptoService(rootSecret, encodingKey);
  });

  describe('constructor', () => {
    it('rejects an encryption key that is not exactly 32 bytes', () => {
      expect(() => new PiiCryptoService(rootSecret, randomBytes(16).toString('base64'))).toThrow(
        PiiCryptoError,
      );
    });
  });

  describe('encrypt/decrypt', () => {
    it('round-trips a value', () => {
      const ciphertext = service.encrypt('ada@example.com');
      expect(service.decrypt(ciphertext)).toBe('ada@example.com');
    });

    it('produces a different ciphertext every time (non-deterministic)', () => {
      const first = service.encrypt('ada@example.com');
      const second = service.encrypt('ada@example.com');

      // Deterministic encryption would leak which rows hold the same address.
      expect(first).not.toBe(second);
      expect(service.decrypt(first)).toBe(service.decrypt(second));
    });

    it('binds ciphertext to the additional authenticated data', () => {
      const ciphertext = service.encrypt('+5215512345678', { aad: 'tenant-user.phone' });

      // Moving the value to another column must not decrypt.
      expect(() => service.decrypt(ciphertext, { aad: 'tenant-user.email' })).toThrow(PiiCryptoError);
      expect(service.decrypt(ciphertext, { aad: 'tenant-user.phone' })).toBe('+5215512345678');
    });

    it('rejects a tampered ciphertext', () => {
      const ciphertext = service.encrypt('ada@example.com');
      const raw = Buffer.from(ciphertext, 'base64url');
      raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;

      expect(() => service.decrypt(raw.toString('base64url'))).toThrow(PiiCryptoError);
    });

    it('rejects a ciphertext produced with a different key', () => {
      const other = new PiiCryptoService('another-root-secret', randomBytes(32).toString('base64'));
      const ciphertext = other.encrypt('ada@example.com');

      expect(() => service.decrypt(ciphertext)).toThrow(PiiCryptoError);
    });

    it('rejects malformed input', () => {
      expect(() => service.encrypt('')).toThrow(PiiCryptoError);
      expect(() => service.decrypt('')).toThrow(PiiCryptoError);
      expect(() => service.decrypt('aGk')).toThrow(PiiCryptoError);
    });

    it('does not leak the failure reason when authentication fails', () => {
      const ciphertext = service.encrypt('secret');
      const other = new PiiCryptoService(rootSecret, randomBytes(32).toString('base64'));

      try {
        other.decrypt(ciphertext);
        throw new Error('expected a PiiCryptoError');
      } catch (error) {
        // The message must be identical for "wrong key" and "tampered payload",
        // otherwise the helper becomes a decryption oracle.
        expect((error as Error).message).toBe('Unable to decrypt value: authentication failed.');
      }
    });
  });

  describe('blindIndex', () => {
    it('is deterministic for the same input', () => {
      expect(service.blindIndex('ada@example.com')).toBe(service.blindIndex('ada@example.com'));
    });

    it('is case and whitespace insensitive', () => {
      expect(service.blindIndex('  Ada@Example.COM ')).toBe(service.blindIndex('ada@example.com'));
    });

    it('produces distinct indexes for distinct values', () => {
      expect(service.blindIndex('ada@example.com')).not.toBe(service.blindIndex('grace@example.com'));
    });

    it('differs when the root secret differs', () => {
      const other = new PiiCryptoService('another-root-secret', encodingKey);
      expect(service.blindIndex('ada@example.com')).not.toBe(other.blindIndex('ada@example.com'));
    });

    it('returns a 64 character hex string that fits the column width', () => {
      expect(service.blindIndex('ada@example.com')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never reveals the input', () => {
      expect(service.blindIndex('ada@example.com')).not.toContain('ada');
    });
  });

  describe('hashIp', () => {
    it('is keyed and deterministic', () => {
      const first = service.hashIp('192.0.2.10');
      const second = service.hashIp('192.0.2.10');
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns null when no address is available', () => {
      expect(service.hashIp(undefined)).toBeNull();
      expect(service.hashIp(null)).toBeNull();
      expect(service.hashIp('')).toBeNull();
    });

    it('does not reveal the address', () => {
      expect(service.hashIp('192.0.2.10')).not.toContain('192');
    });
  });

  describe('sha256', () => {
    it('matches the known digest of an empty string', () => {
      expect(PiiCryptoService.sha256('')).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });
  });

  describe('safeEquals', () => {
    it('compares equal and unequal values', () => {
      expect(PiiCryptoService.safeEquals('abc', 'abc')).toBe(true);
      expect(PiiCryptoService.safeEquals('abc', 'abd')).toBe(false);
    });

    it('handles different lengths without throwing', () => {
      expect(PiiCryptoService.safeEquals('abc', 'abcdef')).toBe(false);
    });
  });

  describe('normalize', () => {
    it('trims and lower-cases', () => {
      expect(PiiCryptoService.normalizeEmail('  Ada@Example.com ')).toBe('ada@example.com');
    });
  });
});
