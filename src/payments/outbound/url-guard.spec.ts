import 'reflect-metadata';
import { UrlGuard, UrlRejectedError, isBlockedAddress, type DnsAnswer, type DnsResolver } from './url-guard';

/** Resolver that answers from a fixed table, so nothing is looked up. */
function resolverOver(answers: Record<string, DnsAnswer[]>): DnsResolver {
  return {
    lookup: (hostname: string) => {
      const found = answers[hostname];
      if (found === undefined) {
        return Promise.reject(new Error('ENOTFOUND'));
      }
      return Promise.resolve(found);
    },
  };
}

const PUBLIC: DnsAnswer = { address: '93.184.216.34', family: 4 };

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback range'],
    ['10.0.0.5', 'RFC1918'],
    ['172.16.0.1', 'RFC1918'],
    ['192.168.1.1', 'RFC1918'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public DNS'],
    ['93.184.216.34', 'public web'],
    ['172.32.0.1', 'just above RFC1918'],
    ['192.169.1.1', 'just above 192.168/16'],
    ['100.128.0.1', 'just above CGNAT'],
  ])('allows %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('blocks IPv6 loopback, unique-local and link-local', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });

  it('blocks the hexadecimal spelling of an IPv4-mapped address, which is what a URL produces', () => {
    // `new URL('https://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`,
    // so the dotted-only check this replaces would have let it through.
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
    expect(isBlockedAddress('::ffff:a00:1')).toBe(true); // 10.0.0.1
    expect(isBlockedAddress('::ffff:ac10:1')).toBe(true); // 172.16.0.1
    expect(isBlockedAddress('::ffff:8.8.8.8'.replace('8.8.8.8', '0808:0808'))).toBe(false);
  });

  it('blocks IPv4-mapped IPv6, the form that defeats an IPv4-only check', () => {
    // ::ffff:127.0.0.1 is loopback even though it starts with a public-looking
    // prefix.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('UrlGuard', () => {
  it('accepts a public HTTPS destination and pins it to the validated address', async () => {
    const guard = new UrlGuard(resolverOver({ 'hooks.example.com': [PUBLIC] }));
    const validated = await guard.validate('https://hooks.example.com/payments');
    // The URL is the subscribed one; the pin is the address list, which the
    // transport connects to instead of resolving the name again.
    expect(validated.url).toBe('https://hooks.example.com/payments');
    expect(validated.hostname).toBe('hooks.example.com');
    expect(validated.hostHeader).toBe('hooks.example.com');
    expect(validated.address).toBe('93.184.216.34');
    expect(validated.addresses).toEqual([PUBLIC]);
  });

  it('keeps the scheme, port, path and query of the subscribed URL', async () => {
    const guard = new UrlGuard(resolverOver({ 'hooks.example.com': [PUBLIC] }));
    const validated = await guard.validate('https://hooks.example.com:8443/x/y?a=1&b=two');
    expect(validated.url).toBe('https://hooks.example.com:8443/x/y?a=1&b=two');
    expect(validated.hostHeader).toBe('hooks.example.com:8443');
  });

  it('refuses a non-HTTPS destination when HTTPS is required', async () => {
    const guard = new UrlGuard(resolverOver({ 'hooks.example.com': [PUBLIC] }));
    await expect(guard.validate('http://hooks.example.com/payments')).rejects.toMatchObject({
      reason: 'HTTPS_REQUIRED',
    });
  });

  it('allows plain HTTP when the policy says so, but still checks the address', async () => {
    const guard = new UrlGuard(resolverOver({ localhost: [{ address: '127.0.0.1', family: 4 }] }), false);
    await expect(guard.validate('http://localhost/x')).rejects.toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it.each(['127.0.0.1', '10.1.2.3', '192.168.0.5', '169.254.169.254', '::1', '::ffff:127.0.0.1'])(
    'refuses %s before any connection',
    async (address) => {
      const family = address.includes(':') ? 6 : 4;
      const guard = new UrlGuard(resolverOver({ 'evil.example.com': [{ address, family }] }));
      await expect(guard.validate('https://evil.example.com/steal')).rejects.toBeInstanceOf(UrlRejectedError);
    },
  );

  it('names the metadata address specifically, so the operator can tell it apart', async () => {
    const guard = new UrlGuard(
      resolverOver({ 'meta.example.com': [{ address: '169.254.169.254', family: 4 }] }),
    );
    await expect(guard.validate('https://meta.example.com/')).rejects.toMatchObject({
      reason: 'METADATA_ADDRESS',
    });
  });

  it('refuses a name when any of its addresses is private, which is the rebinding shape', async () => {
    const guard = new UrlGuard(
      resolverOver({
        'rebind.example.com': [PUBLIC, { address: '127.0.0.1', family: 4 }],
      }),
    );
    await expect(guard.validate('https://rebind.example.com/')).rejects.toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  describe('a name with several public addresses (PaaS, CDN)', () => {
    const v4 = Array.from({ length: 8 }, (_, i): DnsAnswer => ({
      address: `93.184.216.${30 + i}`,
      family: 4,
    }));
    const v6 = Array.from({ length: 8 }, (_, i): DnsAnswer => ({
      address: `2606:2800:220:1::${i + 1}`,
      family: 6,
    }));

    it('accepts 8 A + 8 AAAA public answers and offers every one of them, IPv4 first', async () => {
      // AAAA first on purpose: the guard, not the resolver, decides the order.
      const guard = new UrlGuard(resolverOver({ 'hooks.example': [...v6, ...v4] }));
      const validated = await guard.validate('https://hooks.example/payments');
      expect(validated.addresses).toHaveLength(16);
      expect(validated.addresses.slice(0, 8).every((a) => a.family === 4)).toBe(true);
      expect(validated.addresses.slice(8).every((a) => a.family === 6)).toBe(true);
      expect(validated.address).toBe('93.184.216.30');
      expect(validated.family).toBe(4);
    });

    it('collapses duplicate answers', async () => {
      const guard = new UrlGuard(resolverOver({ 'hooks.example': [PUBLIC, PUBLIC, PUBLIC] }));
      await expect(guard.validate('https://hooks.example/')).resolves.toMatchObject({
        addresses: [PUBLIC],
      });
    });

    it('refuses the whole name with 422 BLOCKED_ADDRESS when one answer is 10.0.0.1', async () => {
      const guard = new UrlGuard(
        resolverOver({ 'hooks.example': [...v4, { address: '10.0.0.1', family: 4 }, ...v6] }),
      );
      const error = await guard.validate('https://hooks.example/').then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(UrlRejectedError);
      expect(error).toMatchObject({ reason: 'PRIVATE_ADDRESS', code: 'BLOCKED_ADDRESS', status: 422 });
    });

    it('names the metadata address even when it hides among public ones', async () => {
      const guard = new UrlGuard(
        resolverOver({ 'hooks.example': [...v4, { address: '169.254.169.254', family: 4 }] }),
      );
      await expect(guard.validate('https://hooks.example/')).rejects.toMatchObject({
        reason: 'METADATA_ADDRESS',
        code: 'BLOCKED_ADDRESS',
      });
    });

    it('refuses an IPv6 unique-local answer hidden among public ones', async () => {
      const guard = new UrlGuard(
        resolverOver({ 'hooks.example': [...v4, ...v6, { address: 'fd00::1', family: 6 }] }),
      );
      await expect(guard.validate('https://hooks.example/')).rejects.toMatchObject({
        reason: 'PRIVATE_ADDRESS',
      });
    });

    it('applies the egress allow-list to every answer, not just the first', async () => {
      const guard = new UrlGuard(
        resolverOver({ 'hooks.example': [PUBLIC, { address: '8.8.8.8', family: 4 }] }),
        true,
        ['93.184.0.0/16'],
      );
      await expect(guard.validate('https://hooks.example/')).rejects.toMatchObject({
        reason: 'NOT_ALLOWED_BY_POLICY',
        code: 'BLOCKED_ADDRESS',
      });
    });
  });

  it('reports a malformed URL as a 400 validation error, not a blocked address', async () => {
    const guard = new UrlGuard(resolverOver({}));
    await expect(guard.validate('not a url')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('checks a literal IP without resolving anything', async () => {
    const guard = new UrlGuard(resolverOver({}));
    await expect(guard.validate('https://93.184.216.34/hook')).resolves.toMatchObject({
      address: '93.184.216.34',
    });
    await expect(guard.validate('https://127.0.0.1/hook')).rejects.toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it('refuses a name that does not resolve', async () => {
    const guard = new UrlGuard(resolverOver({}));
    await expect(guard.validate('https://nowhere.example.com/')).rejects.toMatchObject({
      reason: 'UNRESOLVED',
    });
  });

  it('refuses a value that is not a URL at all', async () => {
    const guard = new UrlGuard(resolverOver({}));
    await expect(guard.validate('not a url')).rejects.toMatchObject({ reason: 'INVALID_URL' });
    await expect(guard.validate('')).rejects.toMatchObject({ reason: 'INVALID_URL' });
  });

  it('applies the egress allow-list when one is configured', async () => {
    const guard = new UrlGuard(resolverOver({ 'hooks.example.com': [PUBLIC] }), true, ['93.184.0.0/16']);
    await expect(guard.validate('https://hooks.example.com/')).resolves.toBeDefined();

    const narrow = new UrlGuard(resolverOver({ 'hooks.example.com': [PUBLIC] }), true, ['10.0.0.0/8']);
    await expect(narrow.validate('https://hooks.example.com/')).rejects.toMatchObject({
      reason: 'NOT_ALLOWED_BY_POLICY',
    });
  });

  it('validates again on every call, so a re-resolve cannot slip past', async () => {
    let answer: DnsAnswer = PUBLIC;
    const guard = new UrlGuard({
      lookup: () => Promise.resolve([answer]),
    });
    await expect(guard.validate('https://flip.example.com/')).resolves.toBeDefined();
    // The name now resolves privately; the next attempt must notice.
    answer = { address: '127.0.0.1', family: 4 };
    await expect(guard.validate('https://flip.example.com/')).rejects.toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });
});
