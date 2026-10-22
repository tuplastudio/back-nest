import { HttpStatus } from '@nestjs/common';
import { isIP } from 'node:net';
import { AppException } from '../../common/errors/app.exception';

/** A DNS answer, resolved by the injected resolver. */
export interface DnsAnswer {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Injected so tests resolve nothing. */
export interface DnsResolver {
  lookup(hostname: string): Promise<DnsAnswer[]>;
}

/** Why a destination was refused. */
export type UrlRejectionReason =
  | 'INVALID_URL'
  | 'HTTPS_REQUIRED'
  | 'UNRESOLVED'
  | 'PRIVATE_ADDRESS'
  | 'METADATA_ADDRESS'
  | 'NOT_ALLOWED_BY_POLICY';

/** Reasons that mean "the URL is well formed, but where it points is off limits". */
const BLOCKED_REASONS: ReadonlySet<UrlRejectionReason> = new Set([
  'PRIVATE_ADDRESS',
  'METADATA_ADDRESS',
  'NOT_ALLOWED_BY_POLICY',
]);

/** A destination that passed validation. */
export interface ValidatedUrl {
  /**
   * The subscribed URL, normalised but otherwise untouched: scheme, host, port,
   * path and query are exactly what the tenant registered.
   */
  readonly url: string;
  /** Hostname without brackets. Drives SNI and certificate validation. */
  readonly hostname: string;
  /** Host header value, including a non-default port. */
  readonly hostHeader: string;
  /**
   * Every address the host resolved to, each one validated, IPv4 first. The
   * transport connects to these and never resolves the name again, which is
   * what keeps the pin: a connection can only reach an address checked here.
   */
  readonly addresses: readonly DnsAnswer[];
  /** The preferred address, `addresses[0]`. */
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Raised for any destination that must not be contacted.
 *
 * Extends {@link AppException} rather than `Error` so the refusal is reported
 * as the client error it is; a generic error would surface as a 500, which both
 * misattributes a client mistake to the server and pollutes the 5xx log. A URL
 * that points at a forbidden address is a well-formed request the server
 * refuses to act on, so it is a 422 `BLOCKED_ADDRESS`; anything else (not a URL,
 * wrong scheme, a name that does not resolve) is a plain 400.
 */
export class UrlRejectedError extends AppException {
  constructor(
    readonly reason: UrlRejectionReason,
    readonly detail: string,
  ) {
    const blocked = BLOCKED_REASONS.has(reason);
    super(
      `The webhook URL was refused: ${reason}.`,
      blocked ? 'BLOCKED_ADDRESS' : 'VALIDATION_ERROR',
      blocked ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.BAD_REQUEST,
      { reason, detail },
    );
  }
}

/**
 * Validates a tenant-supplied webhook destination.
 *
 * A webhook endpoint URL comes from a tenant, which turns every delivery into an
 * attempted outbound request from our own network. That is the dominant risk of
 * the outbound feature, so this is deliberately strict:
 *
 * - HTTPS only by default.
 * - The hostname is resolved and **every** answer is checked. A name that
 *   resolves to a loopback, RFC1918 or link-local address is refused, including
 *   `169.254.169.254`, which is the cloud instance metadata service and the
 *   usual target of an SSRF attempt.
 * - IPv6 is handled explicitly, including the IPv4-mapped form
 *   (`::ffff:127.0.0.1`) that defeats checks which only look at IPv4.
 * - A name with several answers is normal (any PaaS or CDN publishes several A
 *   and AAAA records), so it is accepted only when **every** answer passes. One
 *   private answer among public ones is exactly the DNS-rebinding pattern, and
 *   it refuses the whole name.
 * - The validated addresses are returned and the transport **pins** the
 *   connection to them, IPv4 first, falling back to the next validated address
 *   only when connecting fails. It never resolves the name again, so the
 *   connection cannot be re-pointed between the check and the connect.
 * - The check runs again on every delivery, not only at registration.
 */
export class UrlGuard {
  constructor(
    private readonly resolver: DnsResolver,
    private readonly requireHttps: boolean = true,
    private readonly allowedCidrs: readonly string[] = [],
  ) {}

  /**
   * Validates a destination.
   *
   * @param raw URL supplied by the tenant.
   * @returns A pinned, validated destination.
   * @throws {UrlRejectedError} When the destination must not be contacted.
   */
  async validate(raw: string): Promise<ValidatedUrl> {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new UrlRejectedError('INVALID_URL', 'the value is not a URL');
    }
    if (this.requireHttps && parsed.protocol !== 'https:') {
      throw new UrlRejectedError('HTTPS_REQUIRED', `scheme ${parsed.protocol}`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (hostname.length === 0) {
      throw new UrlRejectedError('INVALID_URL', 'no host');
    }

    // A literal IP needs no DNS, but must still pass the range checks.
    const literalFamily = isIP(hostname);
    const answers: DnsAnswer[] =
      literalFamily !== 0
        ? [{ address: hostname, family: literalFamily as 4 | 6 }]
        : await this.resolve(hostname);

    if (answers.length === 0) {
      throw new UrlRejectedError('UNRESOLVED', hostname);
    }

    // Every answer is checked before any is used. Picking "the public one" from
    // a mixed answer would let the resolver choose where we connect.
    const addresses = preferIpv4(dedupe(answers));
    for (const answer of addresses) {
      if (isBlockedAddress(answer.address)) {
        throw new UrlRejectedError(
          isMetadataAddress(answer.address) ? 'METADATA_ADDRESS' : 'PRIVATE_ADDRESS',
          answer.address,
        );
      }
    }
    for (const answer of addresses) {
      if (!this.isAllowedByPolicy(answer.address)) {
        throw new UrlRejectedError('NOT_ALLOWED_BY_POLICY', answer.address);
      }
    }

    const preferred = addresses[0];
    return {
      url: parsed.toString(),
      hostname,
      hostHeader: parsed.host,
      addresses,
      address: preferred.address,
      family: preferred.family,
    };
  }

  /**
   * Resolves a hostname through the injected resolver.
   *
   * @param hostname Host to resolve.
   * @returns DNS answers.
   */
  private async resolve(hostname: string): Promise<DnsAnswer[]> {
    try {
      return await this.resolver.lookup(hostname);
    } catch {
      throw new UrlRejectedError('UNRESOLVED', hostname);
    }
  }

  /**
   * Applies the optional egress allow-list.
   *
   * @param address Address to check.
   * @returns `true` when allowed. An empty policy allows everything that already
   * passed the range checks.
   */
  private isAllowedByPolicy(address: string): boolean {
    if (this.allowedCidrs.length === 0) {
      return true;
    }
    const value = ipToLong(address);
    if (value === null) {
      return false;
    }
    return this.allowedCidrs.some((cidr) => {
      const [range, bitsRaw] = cidr.split('/');
      const bits =
        bitsRaw === undefined ? (isIP(range ?? '') === 6 ? 128 : 32) : Number.parseInt(bitsRaw, 10);
      const network = ipToLong(range ?? '');
      if (network === null || Number.isNaN(bits)) {
        return false;
      }
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (network & mask) >>> 0;
    });
  }
}

/**
 * Removes repeated answers, keeping the first occurrence.
 *
 * @param answers Resolver output.
 * @returns Distinct answers.
 */
function dedupe(answers: readonly DnsAnswer[]): DnsAnswer[] {
  const seen = new Set<string>();
  const out: DnsAnswer[] = [];
  for (const answer of answers) {
    if (!seen.has(answer.address)) {
      seen.add(answer.address);
      out.push(answer);
    }
  }
  return out;
}

/**
 * Orders answers IPv4 first, keeping the resolver's order within each family.
 *
 * IPv4 first because egress from Cloud Run without a VPC connector is IPv4
 * only: an IPv6 address would fail to connect and only cost a timeout.
 *
 * @param answers Distinct answers.
 * @returns The same answers, reordered.
 */
function preferIpv4(answers: readonly DnsAnswer[]): DnsAnswer[] {
  return [...answers.filter((a) => a.family === 4), ...answers.filter((a) => a.family !== 4)];
}

/**
 * Whether an address is the cloud instance metadata service, in either family.
 *
 * @param address Literal IP address.
 * @returns `true` for `169.254.169.254` and its IPv4-mapped spellings.
 */
function isMetadataAddress(address: string): boolean {
  return (extractIpv4Mapped(address) ?? address) === '169.254.169.254';
}

/**
 * Reports whether an address must never be contacted.
 *
 * Covers loopback, RFC1918, link-local (including the cloud metadata service),
 * CGNAT, multicast, reserved and unspecified ranges, for both families.
 *
 * @param address Literal IP address.
 * @returns `true` when the address is not publicly routable.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = ipv4ToOctets(address);
  if (v4 !== null) {
    const [a, b] = v4;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast, reserved and broadcast
    return false;
  }

  const v4Mapped = extractIpv4Mapped(address);
  if (v4Mapped !== null) {
    // ::ffff:127.0.0.1 is loopback, so the mapped form has to go through the
    // same checks rather than being waved through as "IPv6".
    return isBlockedAddress(v4Mapped);
  }

  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback and unspecified
  if (lower.startsWith('fe80') || lower.startsWith('fec0')) return true; // link-local / site-local
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  if (isIP(address) === 6) return false; // a global unicast IPv6 address

  return true; // not an address at all
}

/**
 * Extracts the IPv4 address from an IPv4-mapped IPv6 address.
 *
 * `::ffff:127.0.0.1` is loopback and must be blocked; a naive IPv6 check misses
 * it because the prefix is neither `::` nor `fc`.
 *
 * @param address IPv6 literal.
 * @returns The dotted IPv4 address, or `null`.
 */
function extractIpv4Mapped(address: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  if (dotted) {
    return dotted[1];
  }
  // `::ffff:7f00:1` and its longer spellings. This is not an exotic form: the
  // WHATWG URL parser normalises a bracketed literal, so a host written as
  // `[::ffff:127.0.0.1]` arrives as `[::ffff:7f00:1]`. Matching only the dotted
  // spelling therefore leaves the form a real URL produces unblocked.
  // The last two groups hold the 32-bit address, most significant half first.
  const hex = /^(?:0*:){0,4}(?:0)*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
  }
  return null;
}

/**
 * Converts an IPv4 literal to a 32-bit number.
 *
 * @param address Literal.
 * @returns Number, or `null` when not IPv4.
 */
function ipv4ToLong(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number.parseInt(part, 10);
    if (octet > 255) {
      return null;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * Splits an IPv4 literal into its four octets.
 *
 * Extracting octets by shifting a 32-bit value is easy to get wrong — `>> 8`
 * yields the third octet, not the second — so they are named instead. Getting
 * this wrong silently unblocks whole private ranges.
 *
 * @param address Literal.
 * @returns Octets, or `null` when not IPv4.
 */
function ipv4ToOctets(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/**
 * Converts an IPv6 literal to a 32-bit number, using only its first 32 bits.
 *
 * The egress allow-list is IPv4-oriented; refusing an IPv6 address when no IPv6
 * CIDR is configured is the safe direction.
 *
 * @param address Literal.
 * @returns Number, or `null` when the literal cannot be reduced.
 */
function ipv6ToLong(address: string): number | null {
  if (isIP(address) !== 6) {
    return null;
  }
  const head = address.split('::')[0] ?? '';
  const first = head.split(':')[0];
  if (first === undefined || !/^[0-9a-f]{1,4}$/i.test(first)) {
    return null;
  }
  return Number.parseInt(first, 16) >>> 0;
}

/**
 * Converts any literal to the 32-bit form used by the allow-list.
 *
 * @param address Literal.
 * @returns Number, or `null`.
 */
function ipToLong(address: string): number | null {
  return ipv4ToLong(address) ?? ipv6ToLong(address);
}
