import 'reflect-metadata';
import { buildEventBody, deliveryHeaders, signDelivery, verifyDelivery } from './signature';

const SECRET = 'whsec_test_secret_value';
const BODY = buildEventBody('evt_1', 'payment.paid', '2026-10-14T00:00:00.000Z', 3, 'tenant-1', {
  orderId: 'order-1',
  amount: '150.75',
});

describe('outbound webhook signature', () => {
  it('round-trips: what we sign, the receiver verifies', () => {
    const timestamp = 1_700_000_000;
    const header = signDelivery(SECRET, BODY, timestamp)['x-mtbpay-signature'];
    expect(verifyDelivery(header, BODY, SECRET, timestamp * 1000)).toEqual({ valid: true });
  });

  it('rejects a tampered body', () => {
    const timestamp = 1_700_000_000;
    const header = signDelivery(SECRET, BODY, timestamp)['x-mtbpay-signature'];
    const tampered = BODY.replace('150.75', '1.00');
    expect(verifyDelivery(header, tampered, SECRET, timestamp * 1000)).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('rejects a delivery signed with a different secret', () => {
    const timestamp = 1_700_000_000;
    const header = signDelivery('whsec_other', BODY, timestamp)['x-mtbpay-signature'];
    expect(verifyDelivery(header, BODY, SECRET, timestamp * 1000)).toMatchObject({ valid: false });
  });

  it('rejects a replayed delivery once the window has passed', () => {
    // This is the reason the timestamp is inside the signed material: without it,
    // a captured request could be replayed indefinitely.
    const signedAt = 1_700_000_000;
    const header = signDelivery(SECRET, BODY, signedAt)['x-mtbpay-signature'];
    expect(verifyDelivery(header, BODY, SECRET, (signedAt + 301) * 1000)).toEqual({
      valid: false,
      reason: 'STALE',
    });
    expect(verifyDelivery(header, BODY, SECRET, (signedAt + 60) * 1000)).toEqual({ valid: true });
  });

  it('rejects a malformed header', () => {
    expect(verifyDelivery('garbage', BODY, SECRET, 1_700_000_000_000)).toEqual({
      valid: false,
      reason: 'MALFORMED',
    });
    expect(verifyDelivery('t=abc,v1=def', BODY, SECRET, 1_700_000_000_000)).toEqual({
      valid: false,
      reason: 'MALFORMED',
    });
  });

  it('fails when the body is re-serialised before verifying', () => {
    // Why the receiver must verify the raw bytes: JSON key order and spacing
    // are not preserved by a parse/re-stringify round trip.
    const timestamp = 1_700_000_000;
    const header = signDelivery(SECRET, BODY, timestamp)['x-mtbpay-signature'];
    const reserialised = JSON.stringify(JSON.parse(BODY) as unknown, null, 2);
    expect(reserialised).not.toBe(BODY);
    expect(verifyDelivery(header, reserialised, SECRET, timestamp * 1000)).toMatchObject({
      valid: false,
    });
  });

  it('accepts either secret while a rotation overlap emits two signatures', () => {
    // The delivery carries one timestamp and two `v1` values during a rotation,
    // so a subscriber holding the new or the old secret must both accept it.
    const timestamp = 1_700_000_000;
    const current = signDelivery(SECRET, BODY, timestamp)['x-mtbpay-signature'];
    const previous = signDelivery('whsec_previous', BODY, timestamp)['x-mtbpay-signature'];
    const overlap = `${current},v1=${previous.slice(previous.indexOf('v1=') + 3)}`;

    expect(verifyDelivery(overlap, BODY, SECRET, timestamp * 1000)).toEqual({ valid: true });
    expect(verifyDelivery(overlap, BODY, 'whsec_previous', timestamp * 1000)).toEqual({ valid: true });
    // A secret that was never issued for this endpoint still fails.
    expect(verifyDelivery(overlap, BODY, 'whsec_unrelated', timestamp * 1000)).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('carries the headers a subscriber needs to deduplicate', () => {
    const headers = deliveryHeaders('evt_42', 'payment.paid', 2);
    expect(headers['x-mtbpay-event-id']).toBe('evt_42');
    expect(headers['x-mtbpay-event-type']).toBe('payment.paid');
    // The attempt counter changes between retries; the event id does not.
    expect(headers['x-mtbpay-attempt']).toBe('2');
    expect(headers['content-type']).toBe('application/json');
  });

  it('builds a body with a stable shape and a sequence for gap detection', () => {
    const parsed = JSON.parse(BODY) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'eventId',
      'eventType',
      'occurredAt',
      'sequence',
      'tenantId',
      'data',
    ]);
    expect(parsed['sequence']).toBe(3);
  });
});
