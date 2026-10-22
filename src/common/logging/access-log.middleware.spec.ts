import express, { type Request } from 'express';
import request from 'supertest';
import { JsonLogger } from './json-logger';
import { createAccessLogMiddleware, redactPath } from './access-log.middleware';

/** Builds an Express app wired like main.ts: access log first, routes after. */
function appWith(level: 'log' | 'warn' = 'log') {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({
    level,
    projectId: 'vondi-0q',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const app = express();
  app.use(
    createAccessLogMiddleware(logger, {
      // Stands in for RequestContextService: the values only exist once the
      // downstream middleware has run, which is the point of the snapshot.
      snapshot: (req: Request) => ({
        requestId: req.id,
        tenantId: req.get('x-tenant-id'),
      }),
    }),
  );
  app.use((req, _res, next) => {
    req.id = 'req-abcdef12';
    next();
  });
  app.get('/api/v1/payments/orders/:id', (req, res) => {
    logger.log('handler log', 'Orders');
    res.status(200).json({ id: req.params.id });
  });
  app.post('/api/v1/payments/webhook/:token', (_req, res) => {
    res.status(500).json({ error: 'boom' });
  });
  app.get('/api/v1/missing-thing', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });
  return { app, lines };
}

const TRACE = '105445aa7843bc8bf206b12000100000';

describe('access log middleware', () => {
  it('writes exactly one access line per request with the required fields', async () => {
    const { app, lines } = appWith();

    await request(app)
      .get('/api/v1/payments/orders/ord_1?secret=x')
      .set('x-cloud-trace-context', `${TRACE}/7;o=1`)
      .set('x-tenant-id', 'tenant-1')
      .expect(200);

    const access = lines.filter((line) => line['type'] === 'access');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      severity: 'INFO',
      requestId: 'req-abcdef12',
      tenantId: 'tenant-1',
      method: 'GET',
      route: '/api/v1/payments/orders/:id',
      status: 200,
      'logging.googleapis.com/trace': `projects/vondi-0q/traces/${TRACE}`,
      'logging.googleapis.com/spanId': '7',
      httpRequest: {
        requestMethod: 'GET',
        requestUrl: '/api/v1/payments/orders/ord_1',
        status: 200,
      },
    });
    expect(typeof access[0]?.['latencyMs']).toBe('number');
    expect(access[0]?.['latencyMs']).toBeGreaterThanOrEqual(0);
  });

  it('propagates the trace to application logs emitted while handling the request', async () => {
    const { app, lines } = appWith();

    await request(app).get('/api/v1/payments/orders/1').set('x-cloud-trace-context', `${TRACE}/1`);

    const handler = lines.find((line) => line['message'] === 'handler log');
    expect(handler?.['logging.googleapis.com/trace']).toBe(`projects/vondi-0q/traces/${TRACE}`);
  });

  it('redacts the inbound webhook token (BN-TASK-033) and logs a 5xx as ERROR', async () => {
    const { app, lines } = appWith();

    await request(app).post('/api/v1/payments/webhook/s3cr3t-token-value').expect(500);

    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain('s3cr3t-token-value');
    const access = lines.find((line) => line['type'] === 'access');
    expect(access).toMatchObject({
      severity: 'ERROR',
      status: 500,
      httpRequest: { requestUrl: '/api/v1/payments/webhook/[REDACTED]' },
    });
  });

  it('logs a 4xx as WARNING', async () => {
    const { app, lines } = appWith();
    await request(app).get('/api/v1/missing-thing').expect(404);
    expect(lines.find((line) => line['type'] === 'access')).toMatchObject({ severity: 'WARNING' });
  });

  it('honours LOG_LEVEL: a 2xx access line is an INFO entry and is dropped at warn', async () => {
    const { app, lines } = appWith('warn');
    await request(app).get('/api/v1/payments/orders/1').expect(200);
    await request(app).get('/api/v1/missing-thing').expect(404);
    expect(lines.filter((line) => line['type'] === 'access').map((line) => line['status'])).toEqual([404]);
  });
});

describe('redactPath', () => {
  it.each([
    ['/api/v1/payments/webhook/abc', '/api/v1/payments/webhook/[REDACTED]'],
    ['/payments/webhook/abc/extra?x=1', '/payments/webhook/[REDACTED]/extra'],
    ['/payments/webhook/', '/payments/webhook/'],
    ['/api/v1/payments/orders/1?token=x', '/api/v1/payments/orders/1'],
  ])('%s -> %s', (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });
});
