import { Controller, Get, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { installLogging, type RequestContextReader } from './install-logging';

@Controller('things')
class ThingsController {
  private readonly logger = new Logger('Things');

  @Get()
  list(): { ok: true } {
    this.logger.log('listing things');
    this.logger.debug('debug detail');
    return { ok: true };
  }
}

describe('installLogging (BN-TASK-036, wiring used by main.ts)', () => {
  let app: INestApplication;
  let lines: Array<Record<string, unknown>>;

  async function boot(level: 'log' | 'debug'): Promise<void> {
    lines = [];
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    const context: RequestContextReader = {
      get: () => ({ requestId: 'req-1234abcd', tenant: { id: 'tenant-1' } }),
    };
    installLogging(app, { logLevel: level, gcpProjectId: 'vondi-0q' }, context, (line) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
    );
    await app.init();
  }

  afterEach(async () => {
    await app.close();
  });

  it('routes Nest loggers through JSON with request fields, and writes one access line', async () => {
    await boot('log');
    await request(app.getHttpServer())
      .get('/things')
      .set('x-cloud-trace-context', '0123456789abcdef0123456789abcdef/1;o=1')
      .expect(200);

    const handler = lines.find((l) => l['message'] === 'listing things');
    expect(handler).toMatchObject({
      severity: 'INFO',
      context: 'Things',
      requestId: 'req-1234abcd',
      tenantId: 'tenant-1',
      'logging.googleapis.com/trace': 'projects/vondi-0q/traces/0123456789abcdef0123456789abcdef',
    });

    const access = lines.find((l) => l['type'] === 'access');
    expect(access).toMatchObject({
      severity: 'INFO',
      route: '/things',
      status: 200,
      requestId: 'req-1234abcd',
      tenantId: 'tenant-1',
    });
    expect(typeof access?.['latencyMs']).toBe('number');
  });

  it('honours LOG_LEVEL', async () => {
    await boot('log');
    await request(app.getHttpServer()).get('/things').expect(200);
    expect(lines.some((l) => l['message'] === 'debug detail')).toBe(false);
    await app.close();

    await boot('debug');
    await request(app.getHttpServer()).get('/things').expect(200);
    expect(lines.some((l) => l['message'] === 'debug detail' && l['severity'] === 'DEBUG')).toBe(true);
  });
});
