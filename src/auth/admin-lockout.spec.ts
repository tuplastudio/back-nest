import 'reflect-metadata';
import { jest } from '@jest/globals';
import { InvalidCredentialsException } from '../common/errors/app.exception';
import { AdminAuthService } from './admin-auth.service';
import { AdminMfaService } from './admin-mfa.service';

/**
 * Platform admin lockout: the lock is decided before the password (no oracle),
 * the counter is incremented in the database, and wrong second factors spend the
 * same budget.
 */

const MAX = 5;
const context = { ipHash: 'ip', userAgentHash: 'ua', requestId: 'req-1' };

interface Row {
  id: string;
  passwordHash: string;
  status: string;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  mfaEnabledAt: Date | null;
  mfaSecretCiphertext: string | null;
  mfaLastUsedStep: number | null;
  mfaRecoveryCodeHashes: string[];
}

function fixture(over: Partial<Row> = {}) {
  const row: Row = {
    id: 'admin-1',
    passwordHash: 'real-hash',
    status: 'ACTIVE',
    lockedUntil: null,
    failedLoginAttempts: 0,
    mfaEnabledAt: new Date(),
    mfaSecretCiphertext: 'ciphertext',
    mfaLastUsedStep: null,
    mfaRecoveryCodeHashes: [],
    ...over,
  };
  const updates: Record<string, unknown>[] = [];
  const audits: { action: string; outcome?: string; metadata?: Record<string, unknown> }[] = [];
  const platformAdmin = {
    findUnique: jest.fn(() => Promise.resolve({ ...row })),
    findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...row })),
    // The database applies `{ increment }` atomically; the fake does the same.
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      updates.push(args.data);
      const inc = (args.data['failedLoginAttempts'] as { increment?: number } | undefined)?.increment;
      if (inc !== undefined) {
        row.failedLoginAttempts += inc;
      }
      return Promise.resolve({ ...row });
    }),
    updateMany: jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updates.push({ many: args.data });
      const gte = (args.where['failedLoginAttempts'] as { gte?: number } | undefined)?.gte;
      if (gte !== undefined && row.failedLoginAttempts < gte) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(row, args.data);
      return Promise.resolve({ count: 1 });
    }),
  };
  const prisma = { client: { platformAdmin } } as never;
  const verify = jest.fn((hash: string | null, password: string) =>
    Promise.resolve({ valid: hash === 'real-hash' && password === 'right', needsRehash: false }),
  );
  const passwords = { verify } as never;
  const audit = {
    record: jest.fn((entry: { action: string; outcome?: string; metadata?: Record<string, unknown> }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  } as never;
  const config = { authMaxFailedAttempts: MAX, authLockoutDurationMs: 15 * 60_000 } as never;
  const crypto = { blindIndex: () => 'lookup', decrypt: () => 'GEZDGNBVGY3TQOJQ' } as never;
  const mfa = new AdminMfaService(prisma, crypto, audit, config);
  const auth = new AdminAuthService(prisma, passwords, {} as never, audit, crypto, config, mfa);
  return { auth, mfa, row, updates, audits, verify };
}

describe('platform admin sign-in lockout (no oracle, atomic counter)', () => {
  it('answers a locked account with 401 even for the right password, without checking it', async () => {
    const f = fixture({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(f.auth.signIn('a@b.test', 'right', context)).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    await expect(f.auth.signIn('a@b.test', 'wrong', context)).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    // Both ran the dummy verification only: the real hash was never consulted.
    expect(f.verify.mock.calls.map((c) => c[0])).toEqual([null, null]);
    // Audited as a denied attempt on a locked account, and the budget is not spent.
    expect(f.audits.filter((a) => a.action === 'auth.sign-in')).toEqual([
      expect.objectContaining({ outcome: 'DENIED', metadata: expect.objectContaining({ reason: 'locked' }) }),
      expect.objectContaining({ outcome: 'DENIED', metadata: expect.objectContaining({ reason: 'locked' }) }),
    ]);
    expect(f.updates).toHaveLength(0);
  });

  it('increments the counter in the database and locks (resetting it) at the limit', async () => {
    const f = fixture({ failedLoginAttempts: MAX - 2 });
    await expect(f.auth.signIn('a@b.test', 'wrong', context)).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(f.updates[0]).toMatchObject({ failedLoginAttempts: { increment: 1 } });
    expect(f.row.lockedUntil).toBeNull();

    await expect(f.auth.signIn('a@b.test', 'wrong', context)).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(f.row.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(f.row.failedLoginAttempts).toBe(0);
    expect(f.audits.some((a) => a.action === 'auth.account-locked')).toBe(true);
  });

  it('locks once when two failures cross the limit together', async () => {
    const f = fixture({ failedLoginAttempts: MAX - 1 });
    await Promise.all([
      f.auth.signIn('a@b.test', 'wrong', context).catch(() => undefined),
      f.auth.signIn('a@b.test', 'wrong', context).catch(() => undefined),
    ]);
    expect(f.audits.filter((a) => a.action === 'auth.account-locked')).toHaveLength(1);
  });
});

describe('platform admin MFA codes spend the lockout budget (L2)', () => {
  it('counts a wrong code and locks after the budget, from any route', async () => {
    const f = fixture({ failedLoginAttempts: MAX - 1 });
    await expect(f.mfa.verify('admin-1', 'not-a-code')).resolves.toBe(false);
    expect(f.updates[0]).toMatchObject({ failedLoginAttempts: { increment: 1 } });
    expect(f.row.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts no code at all while the account is locked', async () => {
    const f = fixture({ lockedUntil: new Date(Date.now() + 60_000), mfaRecoveryCodeHashes: ['x'] });
    await expect(f.mfa.verify('admin-1', 'anything')).resolves.toBe(false);
    expect(f.updates).toHaveLength(0);
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'auth.mfa.verify',
        outcome: 'DENIED',
        metadata: { reason: 'locked' },
      }),
    ]);
  });
});
