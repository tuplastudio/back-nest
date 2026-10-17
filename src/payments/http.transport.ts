import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { HttpTransport, HttpResponseLike } from './netpay.client';
import type { OutboundTransport } from './outbound/outbound-dispatcher.service';
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
   * @param url Absolute URL.
   * @param init Request options.
   * @param pinnedAddress Address to connect to instead of resolving again.
   * @returns Status and body.
   */
  private send(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      timeoutMs: number;
      hostHeader?: string;
    },
    pinnedAddress: string | undefined,
  ): Promise<HttpResponseLike> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? httpRequest : httpsRequest;
      const headers: Record<string, string> = {
        ...init.headers,
        ...(init.hostHeader === undefined ? {} : { host: init.hostHeader }),
      };
      const client = transport(
        {
          protocol: target.protocol,
          hostname: pinnedAddress ?? target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: init.method,
          headers,
          timeout: init.timeoutMs,
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
      client.on('timeout', () => {
        client.destroy();
        reject(new Error('Request timed out.'));
      });
      client.on('error', (error) => reject(error));
      if (init.body !== undefined) {
        client.write(init.body);
      }
      client.end();
    });
  }

  /**
   * Issues an outbound webhook delivery to a pinned address.
   *
   * @param url URL already pinned to a validated address by the guard.
   * @param init Request options.
   * @returns Status.
   */
  deliver(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
      hostHeader: string;
    },
  ): Promise<{ status: number }> {
    const target = new URL(url);
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    return this.send(
      `https://${init.hostHeader}${target.pathname}`,
      init,
      // Connect to the address the guard approved, not to the name: otherwise a
      // second lookup could point somewhere else.
      hostname,
    ).then((response) => ({ status: response.status }));
  }
}

/** Outbound transport backed by {@link NodeHttpTransport}. */
@Injectable()
export class NodeOutboundTransport implements OutboundTransport {
  constructor(private readonly http: NodeHttpTransport) {}

  /**
   * @param url URL to deliver to.
   * @param init Request options.
   * @returns Status.
   */
  request(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
      hostHeader: string;
    },
  ): Promise<{ status: number }> {
    return this.http.deliver(url, init);
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
