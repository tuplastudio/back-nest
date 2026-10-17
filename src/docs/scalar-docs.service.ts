import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import type { NestJSReferenceConfiguration } from '@scalar/nestjs-api-reference';
import { type AppConfig } from '../config/app-config.service';

/** Mount path of the OpenAPI JSON document, relative to the docs root. */
export const OPENAPI_JSON_SUFFIX = 'openapi.json';

/**
 * Builds and mounts the Scalar API reference.
 *
 * Why Scalar
 * ----------
 * `@nestjs/swagger` generates the OpenAPI document; Scalar renders it. Keeping
 * both means the contract is machine generated (so it cannot drift from the
 * DTOs) while the human-facing documentation is a modern, responsive reference
 * with a working "try it" console.
 *
 * Security posture
 * ----------------
 * The reference enumerates every endpoint, parameter and error code, which is a
 * reconnaissance map. It is therefore:
 *
 *  * skipped entirely when `DOCS_ENABLED=false`,
 *  * guarded by HTTP Basic auth outside development,
 *  * mounted outside the versioned API prefix, because it is not part of the
 *    product's contract.
 *
 * Mount layout
 * ------------
 * ```
 * GET /<docsPath>              -> Scalar UI (HTML)
 * GET /<docsPath>/openapi.json -> generated OpenAPI 3.1 document
 * ```
 */
export class ScalarDocsService {
  private readonly logger = new Logger(ScalarDocsService.name);

  /**
   * @param config Validated application configuration.
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * Generates the OpenAPI document for the running application.
   *
   * @param app The Nest application.
   * @returns The OpenAPI 3.1 document.
   */
  buildDocument(app: INestApplication): Record<string, unknown> {
    const builder = new DocumentBuilder()
      .setTitle('Multi-tenant API')
      .setDescription(
        [
          'Schema-per-tenant REST API built with NestJS 12, Prisma 7 and PostgreSQL.',
          '',
          '### Selecting a tenant',
          '',
          'Tenant-scoped routes (`/t/**`, `/api-keys/**`) resolve the tenant from, in order of precedence:',
          '',
          '1. `X-Tenant-Id` — tenant UUID, intended for service-to-service calls.',
          '2. `X-Tenant-Slug` — business slug, e.g. `acme`.',
          '3. The request subdomain, e.g. `acme.api.example.com`.',
          '',
          'An API key never selects its own tenant: the tenant comes from the request,',
          'and the key must belong to it.',
          '',
          '### Authentication',
          '',
          '| Caller | Credential | Endpoint |',
          '| --- | --- | --- |',
          '| Platform administrator | JWT access token | `POST /auth/sign-in` |',
          '| Tenant member | JWT access token | `POST /t/auth/sign-in` |',
          '| Machine | API key `mtb_<public>_<secret>` | any tenant-scoped route |',
          '',
          'Access tokens live 15 minutes by default. Refresh tokens rotate on every use,',
          'and replaying a rotated token revokes the whole session family.',
          '',
          '### Security',
          '',
          '- PII is encrypted at rest with AES-256-GCM; equality lookups use a keyed',
          '  HMAC blind index, so no plaintext e-mail or phone number is ever queried.',
          '- Responses and logs expose masked values unless a principal is asking for',
          '  its own data.',
          '- Raw SQL is restricted to parameterised tagged templates; dynamic',
          '  identifiers must pass an allow-list before being quoted.',
          '- Every tenant is isolated in its own PostgreSQL schema, addressed through a',
          '  validated schema name.',
        ].join('\n'),
      )
      .setVersion('1.0.0')
      .setContact('Platform team', 'https://example.com/support', 'platform@example.com')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header', name: 'Authorization' },
        'bearer-jwt',
      )
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Tenant-Id' }, 'tenant-id')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Tenant-Slug' }, 'tenant-slug')
      .addServer(`https://${this.config.apiBaseDomain}`, 'Subdomain')
      .addServer('http://localhost:3000', 'Localhost');

    const document = SwaggerModule.createDocument(app, builder.build(), {
      deepScanRoutes: true,
      operationIdFactory: (controllerKey: string, methodKey: string) => `${controllerKey}_${methodKey}`,
    }) as unknown as Record<string, unknown>;

    // OpenAPI 3.1 is what Scalar and modern clients expect; the DTO-derived
    // schema is already 3.1 compatible.
    document['openapi'] = '3.1.0';
    return document;
  }

  /**
   * Mounts the OpenAPI document and the Scalar UI.
   *
   * @param app The Nest application.
   * @param document The generated OpenAPI document.
   */
  mount(app: INestApplication, document: Record<string, unknown>): void {
    const expressApp = app.getHttpAdapter().getInstance() as NestExpressApplication & {
      get: (path: string, ...handlers: unknown[]) => void;
    };
    const basePath = `/${this.config.docsPath}`;
    const jsonPath = `${basePath}/${OPENAPI_JSON_SUFFIX}`;

    const guards = this.config.isDevelopment ? [] : [this.basicAuthGuard()];

    // The machine-readable contract. Serving it explicitly (rather than through
    // SwaggerModule.setup) keeps the UI and the document on the same base path.
    expressApp.get(jsonPath, ...guards, (_req: unknown, res: { json(value: unknown): void }) => {
      res.json(document);
    });

    // Scalar renders whichever document `url` points at.
    const scalarOptions: NestJSReferenceConfiguration = {
      url: jsonPath,
      darkMode: true,
      hideDownloadButton: false,
      layout: 'modern',
      showSidebar: true,
      withDefaultFonts: false,
      hideClientButton: false,
      authentication: {
        preferredSecurityScheme: ['bearer-jwt'],
      },
      metaData: {
        title: 'Multi-tenant API',
      },
    };

    expressApp.get(basePath, ...guards, apiReference(scalarOptions));
    expressApp.get(`${basePath}/`, ...guards, apiReference(scalarOptions));

    this.logger.log(`Scalar API reference available at ${basePath} (document at ${jsonPath}).`);
  }

  /**
   * Builds an HTTP Basic guard protecting the documentation.
   *
   * Comparison is length-checked and constant-time so the endpoint cannot be used
   * as a timing oracle to recover the password character by character.
   *
   * @returns An Express middleware performing the check.
   */
  private basicAuthGuard(): (
    req: { headers: Record<string, string | undefined> },
    res: {
      setHeader(name: string, value: string): void;
      status(code: number): { end(): void };
      end(): void;
    },
    next: () => void,
  ) => void {
    const expected = `Basic ${Buffer.from(
      `${this.config.docsBasicAuthUser}:${this.config.docsBasicAuthPassword}`,
      'utf8',
    ).toString('base64')}`;

    return (req, res, next) => {
      const provided = req.headers['authorization'];
      if (typeof provided === 'string' && this.constantTimeEquals(provided, expected)) {
        next();
        return;
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="API documentation", charset="UTF-8"');
      res.status(401).end();
    };
  }

  /**
   * Compares two strings in constant time.
   *
   * @param a First value.
   * @param b Second value.
   * @returns `true` when identical.
   */
  private constantTimeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    let diff = bufferA.length ^ bufferB.length;
    const length = Math.max(bufferA.length, bufferB.length);
    for (let index = 0; index < length; index += 1) {
      diff |= (bufferA[index] ?? 0) ^ (bufferB[index] ?? 0);
    }
    return diff === 0;
  }
}
