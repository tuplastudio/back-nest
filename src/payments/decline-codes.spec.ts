import { describe, expect, it } from '@jest/globals';
import { DECLINE_CODES, classifyDecline } from './decline-codes';

/**
 * The table a storefront relies on: Netpay's codes, whatever their origin, end up
 * as one of a handful of stable values.
 */
describe('classifyDecline (BN-REQ-PAY-006)', () => {
  it.each([
    // ISO 8583 issuer answers.
    ['51', 'INSUFFICIENT_FUNDS'],
    ['54', 'CARD_EXPIRED'],
    ['33', 'CARD_EXPIRED'],
    ['05', 'DO_NOT_HONOR'],
    ['01', 'DO_NOT_HONOR'],
    ['57', 'DO_NOT_HONOR'],
    ['14', 'INVALID_CARD'],
    ['15', 'INVALID_CARD'],
    ['N7', 'INVALID_CARD'],
    ['61', 'LIMIT_EXCEEDED'],
    ['65', 'LIMIT_EXCEEDED'],
    ['04', 'FRAUD_SUSPECTED'],
    ['41', 'FRAUD_SUSPECTED'],
    ['43', 'FRAUD_SUSPECTED'],
    ['59', 'FRAUD_SUSPECTED'],
    ['91', 'PROCESSOR_ERROR'],
    ['96', 'PROCESSOR_ERROR'],
    // Gateway (CyberSource-style) reason codes, the family the 3DS 100/475 codes belong to.
    ['204', 'INSUFFICIENT_FUNDS'],
    ['202', 'CARD_EXPIRED'],
    ['203', 'DO_NOT_HONOR'],
    ['233', 'DO_NOT_HONOR'],
    ['205', 'FRAUD_SUSPECTED'],
    ['481', 'FRAUD_SUSPECTED'],
    ['400', 'FRAUD_SUSPECTED'],
    ['476', 'AUTHENTICATION_FAILED'],
    ['210', 'LIMIT_EXCEEDED'],
    ['211', 'INVALID_CARD'],
    ['231', 'INVALID_CARD'],
    ['150', 'PROCESSOR_ERROR'],
    ['151', 'PROCESSOR_ERROR'],
  ])('maps code %s to %s', (code, expected) => {
    expect(classifyDecline({ code })).toEqual({ failureCode: expected, providerCode: code });
  });

  it('accepts numeric codes and pads single-digit issuer codes', () => {
    expect(classifyDecline({ code: 51 }).failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(classifyDecline({ code: 5 }).failureCode).toBe('DO_NOT_HONOR');
    expect(classifyDecline({ code: 204 }).failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it.each([
    ['Rejected by Decision Manager', 'FRAUD_SUSPECTED'],
    ['Fondos insuficientes', 'INSUFFICIENT_FUNDS'],
    ['Insufficient funds', 'INSUFFICIENT_FUNDS'],
    ['Tarjeta vencida', 'CARD_EXPIRED'],
    ['Expired card', 'CARD_EXPIRED'],
    ['Authentication failed', 'AUTHENTICATION_FAILED'],
    ['3DS authentication rejected', 'AUTHENTICATION_FAILED'],
    ['Excede limite', 'LIMIT_EXCEEDED'],
    ['Invalid Token', 'INVALID_CARD'],
    ['Do not honor', 'DO_NOT_HONOR'],
    ['Transaccion rechazada', 'DO_NOT_HONOR'],
  ])('falls back to the message: %s is %s', (message, expected) => {
    expect(classifyDecline({ message }).failureCode).toBe(expected);
  });

  it('prefers a known code over the message', () => {
    expect(classifyDecline({ code: '54', message: 'Rejected by Decision Manager' }).failureCode).toBe(
      'CARD_EXPIRED',
    );
  });

  it('answers UNKNOWN for anything else, and keeps the original code', () => {
    expect(classifyDecline({ code: 'ZZ', message: 'something odd' })).toEqual({
      failureCode: 'UNKNOWN',
      providerCode: 'ZZ',
    });
    expect(classifyDecline({})).toEqual({ failureCode: 'UNKNOWN', providerCode: null });
  });

  it('never keeps an original code that is not a short code', () => {
    expect(classifyDecline({ code: '4111111111111111' }).providerCode).toBeNull();
  });

  it('exposes exactly the documented enum', () => {
    expect([...DECLINE_CODES]).toEqual([
      'INSUFFICIENT_FUNDS',
      'CARD_EXPIRED',
      'DO_NOT_HONOR',
      'FRAUD_SUSPECTED',
      'AUTHENTICATION_FAILED',
      'INVALID_CARD',
      'LIMIT_EXCEEDED',
      'PROCESSOR_ERROR',
      'UNKNOWN',
    ]);
  });
});
