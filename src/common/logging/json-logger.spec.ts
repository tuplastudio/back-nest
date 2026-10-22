import { JsonLogger, parseTraceContext } from './json-logger';

/** Collects every emitted line, parsed. */
function capture(options: Partial<ConstructorParameters<typeof JsonLogger>[0]> = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({
    level: 'log',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    ...options,
  });
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('emits one JSON object per line with Cloud Logging severity', () => {
    const { logger, lines } = capture();

    logger.log('hello', 'Bootstrap');

    expect(lines).toEqual([
      {
        severity: 'INFO',
        message: 'hello',
        context: 'Bootstrap',
        timestamp: '2026-10-21T12:00:00.000Z',
      },
    ]);
  });

  it('maps every Nest level to a Cloud Logging severity', () => {
    const { logger, lines } = capture({ level: 'verbose' });

    logger.fatal('f');
    logger.error('e');
    logger.warn('w');
    logger.log('l');
    logger.debug('d');
    logger.verbose('v');

    expect(lines.map((line) => line['severity'])).toEqual([
      'CRITICAL',
      'ERROR',
      'WARNING',
      'INFO',
      'DEBUG',
      'DEBUG',
    ]);
  });

  it.each([
    ['error', ['ERROR']],
    ['warn', ['ERROR', 'WARNING']],
    ['log', ['ERROR', 'WARNING', 'INFO']],
    ['debug', ['ERROR', 'WARNING', 'INFO', 'DEBUG']],
  ] as const)('honours LOG_LEVEL=%s', (level, expected) => {
    const { logger, lines } = capture({ level });

    logger.error('e');
    logger.warn('w');
    logger.log('l');
    logger.debug('d');

    expect(lines.map((line) => line['severity'])).toEqual(expected);
  });

  it('always emits fatal, whatever the level', () => {
    const { logger, lines } = capture({ level: 'error' });
    logger.fatal('down');
    expect(lines).toHaveLength(1);
  });

  it('keeps the stack of an error separate from the message', () => {
    const { logger, lines } = capture();

    logger.error('boom', 'Error: boom\n    at x (y.ts:1:1)', 'Filter');

    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: 'boom',
      context: 'Filter',
      stack_trace: 'Error: boom\n    at x (y.ts:1:1)',
    });
  });

  it('flattens a structured payload so log-based metrics can extract fields', () => {
    const { logger, lines } = capture();

    logger.log({ event: 'payment_status_change', from: 'PENDING', to: 'PAID' }, 'Payments');

    expect(lines[0]).toMatchObject({
      severity: 'INFO',
      message: 'payment_status_change',
      event: 'payment_status_change',
      from: 'PENDING',
      to: 'PAID',
      context: 'Payments',
    });
  });

  it('does not let a payload overwrite severity or timestamp', () => {
    const { logger, lines } = capture();
    logger.log({ message: 'x', severity: 'DEBUG', timestamp: 'forged' });
    expect(lines[0]).toMatchObject({ severity: 'INFO', timestamp: '2026-10-21T12:00:00.000Z' });
  });

  it('adds requestId, tenantId and the Cloud Trace field from the request context', () => {
    const { logger, lines } = capture({
      projectId: 'vondi-0q',
      context: () => ({
        requestId: 'req-123456',
        tenantId: 'tenant-1',
        traceId: '105445aa7843bc8bf206b12000100000',
        spanId: '1',
        traceSampled: true,
      }),
    });

    logger.log('inside a request');

    expect(lines[0]).toMatchObject({
      requestId: 'req-123456',
      tenantId: 'tenant-1',
      'logging.googleapis.com/trace': 'projects/vondi-0q/traces/105445aa7843bc8bf206b12000100000',
      'logging.googleapis.com/spanId': '1',
      'logging.googleapis.com/trace_sampled': true,
    });
  });

  it('omits the trace field when the project is unknown rather than emitting an invalid name', () => {
    const { logger, lines } = capture({ context: () => ({ traceId: 'abc' }) });
    logger.log('x');
    expect(lines[0]).not.toHaveProperty('logging.googleapis.com/trace');
    expect(lines[0]).toMatchObject({ traceId: 'abc' });
  });

  it('accepts runtime level changes from Nest', () => {
    const { logger, lines } = capture({ level: 'verbose' });
    logger.setLogLevels(['error']);
    logger.warn('hidden');
    logger.error('shown');
    expect(lines.map((line) => line['message'])).toEqual(['shown']);
  });

  it('serialises an Error instance as message plus stack', () => {
    const { logger, lines } = capture();
    logger.error(new Error('bad'));
    expect(lines[0]?.['message']).toBe('bad');
    expect(String(lines[0]?.['stack_trace'])).toContain('Error: bad');
  });
});

describe('parseTraceContext', () => {
  it('parses X-Cloud-Trace-Context', () => {
    expect(parseTraceContext('105445aa7843bc8bf206b12000100000/1;o=1')).toEqual({
      traceId: '105445aa7843bc8bf206b12000100000',
      spanId: '1',
      traceSampled: true,
    });
  });

  it('parses a header without span or options', () => {
    expect(parseTraceContext('105445aa7843bc8bf206b12000100000')).toEqual({
      traceId: '105445aa7843bc8bf206b12000100000',
    });
  });

  it.each([undefined, '', 'not a trace', 'zz/1;o=1', `${'a'.repeat(33)}/1`])(
    'ignores a malformed header (%s)',
    (header) => {
      expect(parseTraceContext(header)).toEqual({});
    },
  );
});
