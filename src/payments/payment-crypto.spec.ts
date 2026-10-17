import { PaymentSecretBox, buildOrderReference } from './payment-secret-box';
import { toAmountString, parseStatus, netpayUrl, NETPAY_HOSTS } from './netpay-endpoints';

const KEY = Buffer.alloc(32, 9).toString('base64');

describe('PaymentSecretBox', () => {
  it('round-trips a secret', () => {
    const box = new PaymentSecretBox(KEY);
    const encrypted = box.encrypt('sk_netpay_abc123', 'aad-1');
    expect(encrypted).not.toContain('sk_netpay_abc123');
    expect(box.decrypt(encrypted, 'aad-1')).toBe('sk_netpay_abc123');
  });

  it('produces a different ciphertext each time', () => {
    const box = new PaymentSecretBox(KEY);
    const first = box.encrypt('sk_netpay_abc123', 'aad-1');
    const second = box.encrypt('sk_netpay_abc123', 'aad-1');
    // A fresh nonce per call, so the same secret is never recognisable twice.
    expect(first).not.toBe(second);
    expect(box.decrypt(first, 'aad-1')).toBe(box.decrypt(second, 'aad-1'));
  });

  it('refuses a wrong AAD, which is what binds a key to its tenant', () => {
    const box = new PaymentSecretBox(KEY);
    const encrypted = box.encrypt('sk_netpay_abc123', 'netpay:config:tenant-a');
    // A row copied from one tenant to another must not decrypt.
    expect(() => box.decrypt(encrypted, 'netpay:config:tenant-b')).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const box = new PaymentSecretBox(KEY);
    const encrypted = box.encrypt('sk_netpay_abc123', 'aad-1');
    const flipped = Buffer.from(encrypted, 'base64url');
    flipped[flipped.length - 1] ^= 0xff;
    expect(() => box.decrypt(flipped.toString('base64url'), 'aad-1')).toThrow();
  });

  it('refuses a key of the wrong length', () => {
    expect(() => new PaymentSecretBox(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
    expect(() => new PaymentSecretBox('not-base64-at-all')).toThrow();
  });

  it('hashes tokens rather than storing them, and compares in constant time', () => {
    const token = PaymentSecretBox.generateToken();
    const hash = PaymentSecretBox.hashToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(token);
    expect(PaymentSecretBox.hashesMatch(hash, PaymentSecretBox.hashToken(token))).toBe(true);
    expect(PaymentSecretBox.hashesMatch(hash, 'f'.repeat(64))).toBe(false);
    expect(PaymentSecretBox.hashesMatch(hash, 'short')).toBe(false);
  });

  it('generates unguessable tokens of a usable length', () => {
    const token = PaymentSecretBox.generateToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(PaymentSecretBox.generateToken()).not.toBe(token);
  });

  it('prefixes signing secrets so a leaked one is recognisable', () => {
    expect(PaymentSecretBox.generateSigningSecret()).toMatch(/^whsec_/);
  });
});

describe('buildOrderReference', () => {
  it('produces a reference carrying the tenant prefix', () => {
    const reference = buildOrderReference('acme');
    expect(reference).toMatch(/^acme_[0-9a-f]{32}$/);
  });

  it('strips characters that have no place in a merchant reference', () => {
    expect(buildOrderReference('ac me;drop')).toMatch(/^acmedrop_[0-9a-f]{32}$/);
  });

  it('caps the prefix length', () => {
    const reference = buildOrderReference('x'.repeat(80));
    expect(reference.split('_')[0]).toHaveLength(16);
  });

  it('is unique per call', () => {
    expect(buildOrderReference('acme')).not.toBe(buildOrderReference('acme'));
  });
});

describe('netpay endpoints', () => {
  it('builds URLs against the two documented environments', () => {
    expect(netpayUrl('SANDBOX', '/checkout')).toBe(
      'https://gateway-154.netpaydev.com/gateway-ecommerce/checkout',
    );
    expect(netpayUrl('LIVE', '/v3/transactions/abc')).toBe(
      'https://suite.netpay.com.mx/gateway-ecommerce/v3/transactions/abc',
    );
  });

  it('refuses a path that could escape the base', () => {
    expect(() => netpayUrl('LIVE', '../evil')).toThrow(/unsafe path|must start with a slash/);
    expect(() => netpayUrl('LIVE', '//evil.example.com')).toThrow(/unsafe path/);
    expect(() => netpayUrl('LIVE', 'checkout')).toThrow(/must start with a slash/);
  });

  it('refuses an unknown environment', () => {
    expect(() => netpayUrl('PREVIEW' as 'LIVE', '/checkout')).toThrow(/Unknown Netpay environment/);
  });

  it('exposes exactly the two documented bases', () => {
    expect(Object.keys(NETPAY_HOSTS).sort()).toEqual(['LIVE', 'SANDBOX']);
  });
});

describe('netpay response parsing', () => {
  it('recognises the documented statuses', () => {
    expect(parseStatus('DONE')).toBe('DONE');
    expect(parseStatus('done')).toBe('DONE');
    expect(parseStatus('REJECT')).toBe('REJECT');
    expect(parseStatus('review')).toBe('REVIEW');
    expect(parseStatus('WAIT_THREEDS')).toBe('WAIT_THREEDS');
    expect(parseStatus('IN_PROCESS')).toBe('IN_PROCESS');
    // Not a provider status: an order is REFUNDED here, never at Netpay.
    expect(parseStatus('REFUNDED')).toBeNull();
  });

  it('returns null for anything it does not know, rather than guessing', () => {
    // An unknown status must not be treated as a success or a failure.
    expect(parseStatus('SOMETHING_NEW')).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
    expect(parseStatus('')).toBeNull();
  });

  it('converts an amount without float drift', () => {
    // 19.99 is not representable in binary floating point; the comparison against
    // the order must not depend on that.
    expect(toAmountString(19.99)).toBe('19.99');
    expect(toAmountString(150.75)).toBe('150.75');
    expect(toAmountString('19.99')).toBe('19.99');
    expect(toAmountString(0.1 + 0.2)).toBe('0.30');
  });

  it('rejects an unusable amount instead of coercing it to zero', () => {
    expect(toAmountString(null)).toBeNull();
    expect(toAmountString(undefined)).toBeNull();
    expect(toAmountString(Number.NaN)).toBeNull();
    expect(toAmountString('abc')).toBeNull();
  });
});
