import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { HttpTransport, HttpResponseLike } from './netpay.client';
import type { OutboundDestination, OutboundTransport } from './outbound/outbound-dispatcher.service';
import type { DnsAnswer, DnsResolver } from './outbound/url-guard';

/**
 * Node HTTPS transport for calls to Netpay.
 *
 * Verifies the certificate strictly. The official reference sample disables both
 * peer and host verification, which would leave a payment confirmation open to a
 * man in the middle — so this implementation refuses to degrade.
 */
@Injectable()
export class NodeHttpTransport implements HttpTransport {
  /**
   * @param url Absolute URL.
   * @param init Request options.
   * @returns Status and body.
   */
  request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  ): Promise<HttpResponseLike> {
    return this.send(url, init, undefined);
  }

  /**
   * Issues one request, optionally pinning the connection to a validated address.
   *
   * The pin works through `lookup`: the request keeps the subscribed hostname,
   * so SNI, certificate validation and the Host header all use the name, while
   * the socket connects to the address handed in and nothing is resolved.
   *
   * @param url Absolute URL.
   * @param init Request options.
   * @param pin Address to connect to instead of resolving the name.
   * @returns Status and body. A failure before the socket connected carries
   * `connectFailed: true`, so the caller knows the request never left.
   */
  private send(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      timeoutMs: number;
    },
    pin: DnsAnswer | undefined,
  ): Promise<HttpResponseLike> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? httpRequest : httpsRequest;
      const hostname = target.hostname.replace(/^\[|\]$/g, '');
      let connected = false;
      const fail = (error: Error): void => {
        if (!connected) {
          (error as Error & { connectFailed?: boolean }).connectFailed = true;
        }
        reject(error);
      };
      const client = transport(
        {
          protocol: target.protocol,
          hostname,
          port: target.port === '' ? undefined : Number(target.port),
          // Path and query exactly as subscribed: a subscriber may route or
          // authenticate on the query string.
          path: `${target.pathname}${target.search}`,
          method: init.method,
          headers: init.headers,
          timeout: init.timeoutMs,
          ...(pin === undefined ? {} : { lookup: pinnedLookup(pin), family: pin.family }),
          ...(pin !== undefined && isIP(hostname) === 0 ? { servername: hostname } : {}),
          // Never follow a redirect: the caller has to decide what to do with one.
          // For the outbound path the guard has already refused the original
          // destination, so following one would only undo that.
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            // Bounded so a hostile endpoint cannot exhaust memory.
            if (size > 64 * 1024) {
              response.destroy();
              reject(new Error('Response exceeded the maximum accepted size.'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      client.on('socket', (socket) => {
        socket.once('connect', () => {
          connected = true;
        });
      });
      client.on('timeout', () => {
        client.destroy();
        fail(new Error('Request timed out.'));
      });
      client.on('error', (error) => fail(error));
      if (init.body !== undefined) {
        client.write(init.body);
      }
      client.end();
    });
  }

  /**
   * Issues an outbound webhook delivery, pinned to validated addresses.
   *
   * Tries the addresses in the order given (the guard puts IPv4 first) and moves
   * to the next one only when the connection could not be established. Once a
   * request has reached a subscriber, any failure is final for this attempt:
   * sending it again to another address could deliver it twice.
   *
   * @param destination The subscribed URL and its validated addresses.
   * @param init Request options. `timeoutMs` bounds the whole attempt, across
   * every address tried.
   * @returns Status.
   * @throws {Error} When no address is given, or the last address failed.
   */
  async deliver(
    destination: OutboundDestination,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    },
  ): Promise<{ status: number }> {
    if (destination.addresses.length === 0) {
      throw new Error('Refusing to deliver: no validated address.');
    }
    const deadline = Date.now() + init.timeoutMs;
    let lastError: unknown = null;
    for (const address of destination.addresses) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      try {
        const response = await this.send(destination.url, { ...init, timeoutMs: remaining }, address);
        return { status: response.status };
      } catch (error) {
        lastError = error;
        if ((error as { connectFailed?: boolean }).connectFailed !== true) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Request timed out.');
  }
}

/**
 * A `lookup` that answers with one fixed, already validated address.
 *
 * Node calls it with `all: true` when it races address families, and expects
 * an array in that case; both shapes are answered with the same single address.
 *
 * @param pin The address to connect to.
 * @returns A lookup function for `http.request`.
 */
function pinnedLookup(pin: DnsAnswer): LookupFunction {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    if (options.all === true) {
      callback(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    callback(null, pin.address, pin.family);
  };
}

/** Outbound transport backed by {@link NodeHttpTransport}. */
@Injectable()
export class NodeOutboundTransport implements OutboundTransport {
  constructor(private readonly http: NodeHttpTransport) {}

  /**
   * @param destination Subscribed URL and validated addresses.
   * @param init Request options.
   * @returns Status.
   */
  request(
    destination: OutboundDestination,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    },
  ): Promise<{ status: number }> {
    return this.http.deliver(destination, init);
  }
}

/** DNS resolver backed by `dns.promises`. */
@Injectable()
export class NodeDnsResolver implements DnsResolver {
  /**
   * @param hostname Host to resolve.
   * @returns Every answer, including IPv4 and IPv6.
   */
  async lookup(hostname: string): Promise<DnsAnswer[]> {
    const records = await dnsLookup(hostname, { all: true });
    return records.map((record) => ({
      address: record.address,
      family: record.family as 4 | 6,
    }));
  }
}
