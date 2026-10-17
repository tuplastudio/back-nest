import { PiiMaskService } from './pii-mask.service';

/**
 * Tests for the PII masking helpers.
 *
 * Masking is the default presentation for PII in responses, so these tests exist
 * to prove a masked value never discloses the original.
 */
describe('PiiMaskService', () => {
  let service: PiiMaskService;

  beforeEach(() => {
    service = new PiiMaskService();
  });

  describe('maskEmail', () => {
    it('keeps the first and last character of the local part', () => {
      expect(service.maskEmail('ada.lovelace@example.com')).toBe('a********e@example.com');
    });

    it('hides the whole local part when it is very short', () => {
      expect(service.maskEmail('ab@example.com')).toBe('***@example.com');
    });

    it('caps the number of asterisks for very long local parts', () => {
      const masked = service.maskEmail(`${'a'.repeat(60)}@example.com`);
      // The asterisk run is capped so a long address does not leak its length.
      expect(masked.endsWith('@example.com')).toBe(true);
      expect(masked).toBe(`a${'*'.repeat(8)}a@example.com`);
    });

    it('is case insensitive', () => {
      expect(service.maskEmail('Ada@Example.com')).toBe(service.maskEmail('ada@example.com'));
    });

    it('never returns the original address', () => {
      expect(service.maskEmail('ada@example.com')).not.toContain('ada@example.com');
    });

    it('degrades gracefully on malformed input', () => {
      expect(service.maskEmail('not-an-email')).toBe('***');
      expect(service.maskEmail('')).toBe('***');
    });
  });

  describe('maskPhone', () => {
    it('keeps the country prefix and the last two digits', () => {
      expect(service.maskPhone('+5215512345678')).toBe('+52*********78');
    });

    it('hides very short numbers entirely', () => {
      expect(service.maskPhone('123')).toBe('***');
    });
  });

  describe('maskIp', () => {
    it('reduces an IPv4 address to its network', () => {
      expect(service.maskIp('192.0.2.42')).toBe('192.0.2.0/24');
    });

    it('reduces an IPv6 address to a /32 prefix', () => {
      expect(service.maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8::/32');
    });

    it('degrades gracefully on malformed input', () => {
      expect(service.maskIp('nonsense')).toBe('***');
    });
  });

  describe('maskName', () => {
    it('keeps only the first letter', () => {
      expect(service.maskName('Ada')).toBe('A**');
    });
  });

  describe('redact', () => {
    it('replaces the value with a fixed placeholder', () => {
      expect(service.redact('super-secret')).toBe('[REDACTED]');
      expect(service.redact('')).toBe('');
    });
  });
});
