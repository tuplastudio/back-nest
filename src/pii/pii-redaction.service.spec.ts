import { PiiRedactionService } from './pii-redaction.service';

/**
 * Tests for the log scrubber.
 *
 * The scrubber is the last line of defence against leaking credentials into a
 * log aggregator, so it is tested for over-redaction as well as under-redaction.
 */
describe('PiiRedactionService', () => {
  describe('when redaction is enabled', () => {
    let service: PiiRedactionService;

    beforeEach(() => {
      service = new PiiRedactionService(true);
    });

    it('redacts credential-shaped keys regardless of case', () => {
      const scrubbed = service.scrub({
        Password: 'hunter2',
        apiKey: 'mtb_abc',
        'x-auth-token': 'value',
        sessionId: 'abc',
      }) as Record<string, unknown>;

      expect(scrubbed['Password']).toBe('[REDACTED]');
      expect(scrubbed['apiKey']).toBe('[REDACTED]');
      expect(scrubbed['x-auth-token']).toBe('[REDACTED]');
      expect(scrubbed['sessionId']).toBe('[REDACTED]');
    });

    it('keeps harmless fields readable', () => {
      const scrubbed = service.scrub({ tenantId: 'abc', slug: 'acme', count: 3, active: true });
      expect(scrubbed).toEqual({ tenantId: 'abc', slug: 'acme', count: 3, active: true });
    });

    it('does not redact allow-listed metadata fields', () => {
      const scrubbed = service.scrub({ api_key_prefix: 'mtb_abc', has_password: true }) as Record<
        string,
        unknown
      >;
      expect(scrubbed['api_key_prefix']).toBe('mtb_abc');
      expect(scrubbed['has_password']).toBe(true);
    });

    it('recurses into nested objects and arrays', () => {
      const scrubbed = service.scrub({
        items: [{ name: 'a', token: 't' }],
        nested: { deep: { password: 'p' } },
      }) as unknown as { items: Array<Record<string, unknown>>; nested: { deep: Record<string, unknown> } };

      expect(scrubbed.items[0]?.['token']).toBe('[REDACTED]');
      expect(scrubbed.nested.deep['password']).toBe('[REDACTED]');
    });

    it('breaks cyclic references instead of overflowing the stack', () => {
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic['self'] = cyclic;

      expect(() => service.scrub(cyclic)).not.toThrow();
      expect(service.scrub<Record<string, unknown>>(cyclic)['self']).toBe('[Circular]');
    });

    it('summarises buffers instead of dumping their contents', () => {
      const scrubbed = service.scrub({ payload: Buffer.from('secret bytes') }) as Record<string, unknown>;
      expect(scrubbed['payload']).toBe('[Buffer 12 bytes]');
    });

    it('renders errors without their stack', () => {
      const scrubbed = service.scrub(new Error('failed for ada@example.com')) as unknown as Record<
        string,
        unknown
      >;
      expect(scrubbed['name']).toBe('Error');
      expect(scrubbed['message']).toBe('failed for a***@example.com');
      expect(scrubbed['stack']).toBeUndefined();
    });

    it('handles Map and Set', () => {
      const scrubbed = service.scrub({
        map: new Map([['password', 'x']]),
        set: new Set(['a']),
      }) as unknown as { map: Record<string, unknown>; set: unknown[] };

      expect(scrubbed.map['password']).toBe('[REDACTED]');
      expect(scrubbed.set).toEqual(['a']);
    });

    it('masks e-mail addresses inside free text', () => {
      expect(service.scrubMessage('could not send to grace.hopper@globex.com today')).toBe(
        'could not send to g***@globex.com today',
      );
    });

    it('serialises to JSON safely', () => {
      expect(service.scrubToJson({ password: 'p' })).toBe('{"password":"[REDACTED]"}');
    });

    it('survives unserialisable values', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      // The cycle is broken during scrubbing, so the result serialises cleanly.
      expect(service.scrubToJson(cyclic)).toBe('{"self":"[Circular]"}');
    });
  });

  describe('when redaction is disabled', () => {
    it('passes values through untouched', () => {
      const service = new PiiRedactionService(false);
      expect(service.isEnabled).toBe(false);
      expect(service.scrub({ password: 'hunter2' })).toEqual({ password: 'hunter2' });
      expect(service.scrubMessage('ada@example.com')).toBe('ada@example.com');
    });
  });
});
