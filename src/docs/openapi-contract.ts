import { EVENT_DESCRIPTIONS, PUBLISHED_EVENTS, eventJsonSchema } from '../payments/event-contract';

/**
 * Parts of the API contract that Nest's Swagger scan cannot see
 * (BN-REQ-API-001, BN-REQ-EVT-011):
 *
 *  * `x-webhooks` — the outbound payment events, with the same JSON Schema that
 *    is published in `docs/events/`, and the headers every delivery carries;
 *  * `components.schemas.ErrorResponse` — the versioned error envelope of
 *    `AllExceptionsFilter` (docs/ERRORS.md), attached as the `default` response
 *    of every operation.
 */

/** Headers of every outbound delivery (`signature.ts`). */
const DELIVERY_HEADERS: readonly { name: string; description: string; schema: Record<string, unknown> }[] = [
  {
    name: 'X-MTBPay-Event-Id',
    description: 'Same as eventId; stable across retries. Deduplicate on it.',
    schema: { type: 'string' },
  },
  { name: 'X-MTBPay-Event-Type', description: 'Same as eventType.', schema: { type: 'string' } },
  {
    name: 'X-MTBPay-Attempt',
    description: 'Attempt number, from 1; kept across an operator replay.',
    schema: { type: 'integer', minimum: 1 },
  },
  {
    name: 'X-MTBPay-Signature',
    description:
      't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">; two v1 values during a secret rotation.',
    schema: { type: 'string' },
  },
  { name: 'X-MTBPay-Delivery', description: 'Signature scheme version.', schema: { type: 'string' } },
];

/** The error envelope of `AllExceptionsFilter`. */
const ERROR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: 'Every error response, whatever layer produced it (BN-REQ-API-002). See docs/ERRORS.md.',
  required: ['error', 'requestId', 'timestamp', 'source'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable discriminator; the only field a client should branch on.',
          examples: ['PROVIDER_OUTCOME_UNKNOWN', 'VALIDATION_ERROR', 'CONFLICT'],
        },
        message: { type: 'string', description: 'Human-readable, English, PII-free. May change.' },
        retryable: { type: 'boolean', description: 'Whether repeating the same request may succeed.' },
        details: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional, non-sensitive context; its shape depends on the code.',
        },
      },
    },
    requestId: { type: 'string', description: 'Correlation id; equals the X-Request-Id response header.' },
    timestamp: { type: 'string', format: 'date-time' },
    source: { type: 'string', enum: ['application', 'http', 'prisma', 'unexpected'] },
  },
};

const DEFAULT_ERROR_RESPONSE = {
  description: 'Error. Branch on error.code; see docs/ERRORS.md.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * Adds `x-webhooks` and the error envelope to a generated document.
 *
 * @param document Document produced by `SwaggerModule.createDocument`.
 * @returns The same document, extended.
 */
export function applyContractExtensions(document: Record<string, unknown>): Record<string, unknown> {
  const components = (document['components'] ?? {}) as { schemas?: Record<string, unknown> };
  components.schemas = { ...(components.schemas ?? {}), ErrorResponse: ERROR_RESPONSE_SCHEMA };
  document['components'] = components;

  const paths = (document['paths'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const item of Object.values(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method) || operation === null || typeof operation !== 'object') {
        continue;
      }
      const responses = ((operation as { responses?: Record<string, unknown> }).responses ??= {});
      responses['default'] ??= DEFAULT_ERROR_RESPONSE;
    }
  }

  const webhooks: Record<string, unknown> = {};
  for (const eventType of PUBLISHED_EVENTS) {
    const { $schema: _schema, $id: _id, ...schema } = eventJsonSchema(eventType);
    webhooks[eventType] = {
      post: {
        operationId: `webhook_${eventType.replace(/\W/g, '_')}`,
        summary: eventType,
        description: `${EVENT_DESCRIPTIONS[eventType]} JSON Schema: docs/events/${eventType}.schema.json.`,
        tags: ['Outbound webhooks'],
        parameters: DELIVERY_HEADERS.map((header) => ({ in: 'header', required: true, ...header })),
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: {
          '2XX': {
            description:
              'Accepted. Any other answer, or none within the timeout, is retried with backoff for 24 h.',
          },
        },
      },
    };
  }
  document['x-webhooks'] = webhooks;
  return document;
}
