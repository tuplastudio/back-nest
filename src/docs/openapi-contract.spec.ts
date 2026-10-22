import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyContractExtensions } from './openapi-contract';
import { PUBLISHED_EVENTS, eventJsonSchema } from '../payments/event-contract';

/**
 * BN-TASK-009 / BN-REQ-API-001: the OpenAPI document carries the outbound events
 * (`x-webhooks`) and the error envelope of every operation.
 */

function minimalDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    paths: {
      '/api/v1/t/payments/orders': {
        get: { operationId: 'list', responses: { '200': { description: 'ok' } } },
        post: { operationId: 'create', responses: { '201': { description: 'created' } } },
      },
    },
    components: { schemas: { SomeDto: { type: 'object' } } },
  };
}

describe('applyContractExtensions', () => {
  it('publishes every event under x-webhooks with its JSON Schema and the delivery headers', () => {
    const document = applyContractExtensions(minimalDocument());
    const webhooks = document['x-webhooks'] as Record<string, { post: Record<string, unknown> }>;
    expect(Object.keys(webhooks)).toEqual([...PUBLISHED_EVENTS]);
    for (const eventType of PUBLISHED_EVENTS) {
      const operation = webhooks[eventType].post;
      const { $schema: _s, $id: _i, ...expected } = eventJsonSchema(eventType);
      expect(operation['requestBody']).toEqual({
        required: true,
        content: { 'application/json': { schema: expected } },
      });
      const headers = (operation['parameters'] as { name: string; in: string }[]).map(
        (p) => `${p.in}:${p.name}`,
      );
      expect(headers).toEqual(
        expect.arrayContaining([
          'header:X-MTBPay-Event-Id',
          'header:X-MTBPay-Signature',
          'header:X-MTBPay-Attempt',
        ]),
      );
    }
  });

  it('documents the versioned error envelope and attaches it to every operation', () => {
    const document = applyContractExtensions(minimalDocument());
    const schemas = (document['components'] as { schemas: Record<string, unknown> }).schemas;
    expect(schemas['SomeDto']).toEqual({ type: 'object' });
    expect(schemas['ErrorResponse']).toMatchObject({
      type: 'object',
      required: ['error', 'requestId', 'timestamp', 'source'],
    });
    const paths = document['paths'] as Record<string, Record<string, { responses: Record<string, unknown> }>>;
    for (const operation of Object.values(paths['/api/v1/t/payments/orders'])) {
      expect(operation.responses['default']).toEqual({
        description: 'Error. Branch on error.code; see docs/ERRORS.md.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      });
    }
  });

  it('is what docs/openapi.json contains (regenerate with npm run docs:openapi)', () => {
    const committed = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'openapi.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(committed['x-webhooks'] as object)).toEqual([...PUBLISHED_EVENTS]);
    expect(
      (committed['components'] as { schemas: Record<string, unknown> }).schemas['ErrorResponse'],
    ).toBeDefined();
  });
});
