import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from './totp';
import { evaluateAdminSession, STEP_UP_MAX_AGE_SECONDS } from './admin-session-policy';

/** RFC 6238 appendix B seed for SHA-1: the ASCII string "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ])('matches the RFC test vector at t=%i', (seconds, code) => {
    expect(totpAt(RFC_SECRET, Math.floor(seconds / 30))).toBe(code);
  });

  it('round-trips base32', () => {
    const encoded = base32Encode(RFC_SECRET);
    expect(encoded).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(encoded).equals(RFC_SECRET)).toBe(true);
  });

  it('accepts the current and adjacent steps, refuses replay and stale codes', () => {
    const now = 1_234_567_890_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 3), now, null)).toBeNull();
    // A code already used (step <= last used) cannot be replayed.
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull();
  });

  it('builds an otpauth URL authenticator apps understand', () => {
    expect(otpauthUrl('ABC', 'a***@x.com', 'netpay-api')).toBe(
      'otpauth://totp/netpay-api:a***%40x.com?secret=ABC&issuer=netpay-api&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('issues distinct recovery codes and hashes them case/format-insensitively', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(hashRecoveryCode(codes[0].toLowerCase().replace('-', ''))).toBe(hashRecoveryCode(codes[0]));
  });
});

describe('platform admin session policy (BN-REQ-SEC-006 / SEC-008)', () => {
  const now = 1_700_000_000;
  const base = {
    mustChangePassword: false,
    mfaEnrolled: true,
    mfaAt: now - 60,
    mfaRequired: true,
    nowSeconds: now,
    allowMfaPending: false,
    allowPasswordChange: false,
    stepUpRequired: false,
  };

  it('allows a verified session', () => {
    expect(evaluateAdminSession(base)).toBeNull();
  });

  it('refuses an admin without MFA with 403 MFA_REQUIRED', () => {
    expect(evaluateAdminSession({ ...base, mfaEnrolled: false, mfaAt: undefined })).toMatchObject({
      code: 'MFA_REQUIRED',
      status: 403,
    });
    expect(evaluateAdminSession({ ...base, mfaAt: undefined })).toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('lets an unverified session reach the MFA endpoints', () => {
    expect(
      evaluateAdminSession({ ...base, mfaEnrolled: false, mfaAt: undefined, allowMfaPending: true }),
    ).toBeNull();
  });

  it('does not require MFA when disabled and not enrolled', () => {
    expect(
      evaluateAdminSession({ ...base, mfaRequired: false, mfaEnrolled: false, mfaAt: undefined }),
    ).toBeNull();
  });

  it('restricts a mustChangePassword admin to the password change endpoint', () => {
    expect(evaluateAdminSession({ ...base, mustChangePassword: true })).toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
      status: 403,
    });
    expect(evaluateAdminSession({ ...base, mustChangePassword: true, allowPasswordChange: true })).toBeNull();
  });

  it('requires a recent MFA (<= 5 min) for step-up routes', () => {
    expect(STEP_UP_MAX_AGE_SECONDS).toBe(300);
    expect(evaluateAdminSession({ ...base, stepUpRequired: true, mfaAt: now - 299 })).toBeNull();
    expect(evaluateAdminSession({ ...base, stepUpRequired: true, mfaAt: now - 301 })).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      status: 403,
    });
  });
});
