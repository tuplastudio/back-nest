import { createCipheriv, randomBytes } from 'node:crypto';
import { Keyring, KeyringError } from './keyring';
import { PiiCryptoService } from './pii-crypto.service';
import { PaymentSecretBox } from '../payments/payment-secret-box';
import { reencryptTarget, type ReencryptRow, type ReencryptTarget } from './reencrypt';

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');

/** Ciphertext in the pre-keyring format: base64url(nonce || tag || body), no prefix. */
function legacyCiphertext(base64Key: string, plaintext: string, aad?: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(base64Key, 'base64'), nonce);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
}

describe('Keyring (BN-REQ-SEC-007)', () => {
  const v1Only = Keyring.fromJson(JSON.stringify({ current: '1', keys: { '1': K1 } }), K1);
  const v2Active = Keyring.fromJson(JSON.stringify({ current: '2', keys: { '1': K1, '2': K2 } }), K1);

  it('prefixes ciphertext with the version of the key that wrote it', () => {
    expect(v1Only.encrypt('secret')).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(v2Active.encrypt('secret')).toMatch(/^v2:/);
  });

  it('with v2 active, reads what v1 wrote and writes with v2', () => {
    const fromV1 = v1Only.encrypt('ada@example.com', 'tenant-user.email');
    expect(v2Active.decrypt(fromV1, 'tenant-user.email')).toBe('ada@example.com');
    const rewritten = v2Active.encrypt('ada@example.com', 'tenant-user.email');
    expect(Keyring.versionOf(rewritten)).toBe('2');
    expect(v2Active.isCurrent(rewritten)).toBe(true);
    expect(v2Active.isCurrent(fromV1)).toBe(false);
  });

  it('reads legacy unprefixed ciphertext with the legacy key', () => {
    const legacy = legacyCiphertext(K1, 'old value', 'aad');
    expect(Keyring.versionOf(legacy)).toBeNull();
    expect(v2Active.decrypt(legacy, 'aad')).toBe('old value');
    expect(v2Active.isCurrent(legacy)).toBe(false);
  });

  it('refuses a version it does not hold, a wrong AAD and tampering', () => {
    const v3 = Keyring.fromJson(JSON.stringify({ current: '3', keys: { '3': K2 } }), K1).encrypt('x');
    expect(() => v2Active.decrypt(v3)).toThrow(KeyringError);
    const good = v2Active.encrypt('x', 'a');
    expect(() => v2Active.decrypt(good, 'b')).toThrow(KeyringError);
    const tampered = `${good.slice(0, -2)}${good.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => v2Active.decrypt(tampered, 'a')).toThrow(KeyringError);
  });

  it('validates the JSON shape', () => {
    expect(() => Keyring.fromJson('{', K1)).toThrow(KeyringError);
    expect(() => Keyring.fromJson(JSON.stringify({ current: '2', keys: { '1': K1 } }), K1)).toThrow(
      /current/,
    );
    expect(() => Keyring.fromJson(JSON.stringify({ current: 'a', keys: { a: K1 } }), K1)).toThrow(
      /positive integer/,
    );
    expect(() =>
      Keyring.fromJson(
        JSON.stringify({ current: '1', keys: { '1': Buffer.alloc(16).toString('base64') } }),
        K1,
      ),
    ).toThrow(/32 bytes/);
  });

  it('single() is the backward-compatible keyring: v1 = the existing key, legacy = the same key', () => {
    const ring = Keyring.single(K1);
    expect(ring.currentVersion).toBe('1');
    expect(ring.decrypt(legacyCiphertext(K1, 'v'))).toBe('v');
  });
});

describe('services on the keyring', () => {
  it('PiiCryptoService writes v-prefixed ciphertext and still reads legacy rows', () => {
    const service = new PiiCryptoService('root-secret-for-tests', K1);
    expect(service.encrypt('a@b.c', { aad: 'x' })).toMatch(/^v1:/);
    expect(service.decrypt(legacyCiphertext(K1, 'a@b.c', 'x'), { aad: 'x' })).toBe('a@b.c');
  });

  it('PiiCryptoService accepts a rotated keyring', () => {
    const rotated = new PiiCryptoService(
      'root-secret-for-tests',
      Keyring.fromJson(JSON.stringify({ current: '2', keys: { '1': K1, '2': K2 } }), K1),
    );
    const old = new PiiCryptoService('root-secret-for-tests', K1).encrypt('a@b.c');
    expect(rotated.decrypt(old)).toBe('a@b.c');
    expect(rotated.encrypt('a@b.c')).toMatch(/^v2:/);
  });

  it('PaymentSecretBox writes v-prefixed ciphertext and still reads legacy rows', () => {
    const box = new PaymentSecretBox(K1);
    expect(box.encrypt('sk_netpay', 'netpay:config:t')).toMatch(/^v1:/);
    expect(box.decrypt(legacyCiphertext(K1, 'sk_netpay', 'netpay:config:t'), 'netpay:config:t')).toBe(
      'sk_netpay',
    );
  });
});

describe('re-encryption job', () => {
  /** In-memory column holding a mix of legacy, v1 and v2 rows. */
  function column(rows: ReencryptRow[]): ReencryptTarget & { rows: ReencryptRow[] } {
    const store = rows.map((r) => ({ ...r }));
    return {
      name: 'test.column',
      rows: store,
      async fetchBatch(afterId, limit) {
        return Promise.resolve(store.filter((r) => r.id > (afterId ?? '')).slice(0, limit));
      },
      async update(id, previous, next) {
        const row = store.find((r) => r.id === id && r.value === previous);
        if (row) {
          row.value = next;
        }
        return Promise.resolve(row !== undefined);
      },
    };
  }

  it('leaves zero rows on v1 or legacy once it has run', async () => {
    const v1 = Keyring.single(K1);
    const v2 = Keyring.fromJson(JSON.stringify({ current: '2', keys: { '1': K1, '2': K2 } }), K1);
    const target = column([
      { id: 'a', value: legacyCiphertext(K1, 'one', 'aad-a'), aad: 'aad-a' },
      { id: 'b', value: v1.encrypt('two', 'aad-b'), aad: 'aad-b' },
      { id: 'c', value: v2.encrypt('three', 'aad-c'), aad: 'aad-c' },
    ]);

    const report = await reencryptTarget(v2, target, { batchSize: 2 });

    expect(report).toEqual({ target: 'test.column', scanned: 3, rewritten: 2, failed: 0 });
    expect(target.rows.every((r) => Keyring.versionOf(r.value) === '2')).toBe(true);
    expect(target.rows.map((r) => v2.decrypt(r.value, r.aad))).toEqual(['one', 'two', 'three']);
  });

  it('dry-run counts without writing', async () => {
    const v2 = Keyring.fromJson(JSON.stringify({ current: '2', keys: { '1': K1, '2': K2 } }), K1);
    const target = column([{ id: 'a', value: Keyring.single(K1).encrypt('x'), aad: undefined }]);
    const report = await reencryptTarget(v2, target, { batchSize: 10, dryRun: true });
    expect(report.rewritten).toBe(1);
    expect(Keyring.versionOf(target.rows[0].value)).toBe('1');
  });
});
