import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  EVENT_DESCRIPTIONS,
  PUBLISHED_EVENTS,
  eventJsonSchema,
  eventSchemaFile,
} from '../src/payments/event-contract';

/**
 * Renders the event contract (`src/payments/event-contract.ts`) into
 * `docs/events/` (BN-REQ-EVT-011):
 *
 *  * `<eventType>.schema.json` — JSON Schema draft 2020-12 of each event body;
 *  * `catalog.json` — every event, what it announces and its schema file.
 *
 * ```bash
 * npm run events:schemas           # write
 * npm run events:schemas -- --check  # exit 1 when a file is stale
 * ```
 *
 * The unit test `event-contract.spec.ts` performs the same comparison, so CI
 * fails on a stale file even without this script.
 */
async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const dir = join(process.cwd(), 'docs', 'events');
  mkdirSync(dir, { recursive: true });

  const files: Record<string, unknown> = {
    'catalog.json': {
      description:
        'Outbound payment events. Each body is signed (X-MTBPay-Signature) and delivered at least once; deduplicate on eventId and order by sequence per order.',
      events: PUBLISHED_EVENTS.map((eventType) => ({
        eventType,
        description: EVENT_DESCRIPTIONS[eventType],
        schema: eventSchemaFile(eventType),
      })),
    },
  };
  for (const eventType of PUBLISHED_EVENTS) {
    files[eventSchemaFile(eventType)] = eventJsonSchema(eventType);
  }

  const stale: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    // Formatted as `npm run format` would, so `format:check` stays green.
    const options = (await resolveConfig(target)) ?? {};
    const rendered = await format(JSON.stringify(content), { ...options, parser: 'json', filepath: target });
    let current: string | null = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
    if (current === rendered) {
      continue;
    }
    if (check) {
      stale.push(name);
    } else {
      writeFileSync(target, rendered, 'utf8');
      process.stdout.write(`wrote docs/events/${name}\n`);
    }
  }
  if (stale.length > 0) {
    process.stderr.write(`docs/events is out of date (${stale.join(', ')}). Run: npm run events:schemas\n`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to render the event schemas: ${(error as Error).message}\n`);
  process.exit(1);
});
