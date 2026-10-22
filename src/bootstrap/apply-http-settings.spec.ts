import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { applyHttpSettings, isOriginAllowed } from './apply-http-settings';
import { ResponseHeadersMiddleware } from './response-headers.middleware';
import { PiiRedactionService } from '../pii/pii-redaction.service';
import type { AppConfig } from '../config/app-config.service';

@Controller('probe')
class ProbeController {
  @Get()
  get(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const STAGING_ORIGIN = 'https://vondi.tupla.dev';

describe('HTTP settings: CORS and fingerprinting headers', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    const config = {
      trustProxyHops: 0,
      docsEnabled: false,
      isDevelopment: false,
      corsOrigins: [STAGING_ORIGIN],
    } as unknown as AppConfig;
    const redaction = new PiiRedactionService(true);
    applyHttpSettings(app, config, redaction);
    // The application also runs this middleware on every route.
    const headers = new ResponseHeadersMiddleware(redaction);
    app.use((req: unknown, res: { setHeader(n: string, v: string): void }, next: () => void) =>
      headers.use(req, res, next),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an allowed preflight with 204 and the origin echoed (BN-REQ-SEC-010)', async () => {
    const response = await request(app.getHttpServer())
      .options('/probe')
      .set('Origin', STAGING_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(STAGING_ORIGIN);
  });

  it('refuses a preflight from a disallowed origin with 403, not 404 (BN-REQ-SEC-010)', async () => {
    const response = await request(app.getHttpServer())
      .options('/probe')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.body).toMatchObject({ error: 'CORS_ORIGIN_NOT_ALLOWED' });
  });

  it('still serves non-browser clients that send no Origin', async () => {
    const response = await request(app.getHttpServer()).get('/probe');
    expect(response.status).toBe(200);
  });

  it('sends no X-Powered-By header at all (BN-REQ-SEC-011)', async () => {
    const response = await request(app.getHttpServer()).get('/probe');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('matches origins exactly', () => {
    expect(isOriginAllowed(STAGING_ORIGIN, [STAGING_ORIGIN])).toBe(true);
    expect(isOriginAllowed(`${STAGING_ORIGIN}.evil.example`, [STAGING_ORIGIN])).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', [STAGING_ORIGIN])).toBe(false);
    expect(isOriginAllowed('https://anything', ['*'])).toBe(true);
  });
});
