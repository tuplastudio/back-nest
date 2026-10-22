import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeHttpTransport, NodeOutboundTransport } from './http.transport';
import type { DnsAnswer } from './outbound/url-guard';

/** What the fake subscriber saw. */
interface Seen {
  readonly method: string;
  readonly url: string;
  readonly host: string | undefined;
  readonly body: string;
}

/**
 * Starts a subscriber on IPv4 loopback only.
 *
 * Binding to 127.0.0.1 and not to `::` is what makes `::1` a dead address in
 * the fallback test: connecting there is refused, or fails as unreachable on a
 * host without IPv6, and either way it is a connect error.
 *
 * @param answer How the subscriber responds.
 * @returns The server, its port and what it received.
 */
async function subscriber(
  answer: (request: IncomingMessage) => { status: number } | 'hang-up' = () => ({ status: 204 }),
): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        host: request.headers.host,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const outcome = answer(request);
      if (outcome === 'hang-up') {
        request.socket.destroy();
        return;
      }
      response.statusCode = outcome.status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

const LOOPBACK: DnsAnswer = { address: '127.0.0.1', family: 4 };
const DEAD_V6: DnsAnswer = { address: '::1', family: 6 };

const INIT = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
  timeoutMs: 3000,
};

describe('NodeOutboundTransport', () => {
  let running: Server[] = [];
  const transport = new NodeOutboundTransport(new NodeHttpTransport());

  afterEach(async () => {
    await Promise.all(running.map((server) => new Promise((resolve) => server.close(resolve))));
    running = [];
  });

  it('sends to the exact subscribed path and query, with the original host and port', async () => {
    const sub = await subscriber();
    running.push(sub.server);
    const url = `http://hooks.test:${sub.port}/x/y?a=1&b=two`;

    const response = await transport.request({ url, addresses: [LOOPBACK] }, INIT);

    expect(response.status).toBe(204);
    expect(sub.seen).toHaveLength(1);
    expect(sub.seen[0].url).toBe('/x/y?a=1&b=two');
    expect(sub.seen[0].host).toBe(`hooks.test:${sub.port}`);
    expect(sub.seen[0].method).toBe('POST');
    expect(sub.seen[0].body).toBe('{"ok":true}');
  });

  it('keeps the plain-http scheme when it was subscribed that way, instead of forcing https', async () => {
    // HTTPS is the guard's policy (`requireHttps`), not the transport's: when
    // the policy allows http, rewriting the scheme would break the delivery.
    const sub = await subscriber();
    running.push(sub.server);
    await expect(
      transport.request({ url: `http://hooks.test:${sub.port}/`, addresses: [LOOPBACK] }, INIT),
    ).resolves.toEqual({ status: 204 });
  });

  it('connects to the pinned address and never resolves the name', async () => {
    // `.invalid` can never resolve (RFC 6761), so a delivery that succeeds
    // proves the transport did not look the name up again.
    const sub = await subscriber();
    running.push(sub.server);
    await expect(
      transport.request({ url: `http://hooks.invalid:${sub.port}/p`, addresses: [LOOPBACK] }, INIT),
    ).resolves.toEqual({ status: 204 });
    expect(sub.seen[0].host).toBe(`hooks.invalid:${sub.port}`);
  });

  it('falls back to the next validated address when connecting fails', async () => {
    const sub = await subscriber();
    running.push(sub.server);
    await expect(
      transport.request({ url: `http://hooks.test:${sub.port}/p`, addresses: [DEAD_V6, LOOPBACK] }, INIT),
    ).resolves.toEqual({ status: 204 });
    expect(sub.seen).toHaveLength(1);
  });

  it('does not try another address once the request reached the subscriber', async () => {
    // A failure after connecting may already have been processed; sending it
    // again to a second address would be a duplicate, not a fallback.
    const sub = await subscriber(() => 'hang-up');
    running.push(sub.server);
    await expect(
      transport.request({ url: `http://hooks.test:${sub.port}/p`, addresses: [LOOPBACK, LOOPBACK] }, INIT),
    ).rejects.toThrow();
    expect(sub.seen).toHaveLength(1);
  });

  it('returns a non-2xx status as an answer, not as a reason to try elsewhere', async () => {
    const sub = await subscriber(() => ({ status: 500 }));
    running.push(sub.server);
    await expect(
      transport.request({ url: `http://hooks.test:${sub.port}/p`, addresses: [LOOPBACK, LOOPBACK] }, INIT),
    ).resolves.toEqual({ status: 500 });
    expect(sub.seen).toHaveLength(1);
  });

  it('fails with the connect error when every address is dead', async () => {
    const sub = await subscriber();
    running.push(sub.server);
    await expect(
      transport.request({ url: `http://hooks.test:${sub.port}/p`, addresses: [DEAD_V6] }, INIT),
    ).rejects.toThrow();
    expect(sub.seen).toHaveLength(0);
  });

  it('refuses to send without a validated address', async () => {
    await expect(transport.request({ url: 'http://hooks.test/p', addresses: [] }, INIT)).rejects.toThrow(
      /no validated address/i,
    );
  });
});
