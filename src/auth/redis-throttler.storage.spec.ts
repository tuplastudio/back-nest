import { jest } from '@jest/globals';
import {
  RedisThrottlerStorage,
  RespReader,
  encodeCommand,
  type RedisEvalClient,
} from './redis-throttler.storage';

describe('RedisThrottlerStorage (BN-REQ-SEC-004 shared storage)', () => {
  it('maps the script reply into a throttler record', async () => {
    const evalScript = jest.fn<RedisEvalClient['evalScript']>().mockResolvedValue([3, 45_000, 0]);
    const storage = new RedisThrottlerStorage({ evalScript });

    const record = await storage.increment('key-1', 60_000, 10, 60_000, 'auth');

    expect(record).toEqual({ totalHits: 3, timeToExpire: 45, isBlocked: false, timeToBlockExpire: 0 });
    const [, keys, args] = evalScript.mock.calls[0];
    expect(keys).toEqual(['throttle:auth:key-1:hits', 'throttle:auth:key-1:blocked']);
    expect(args).toEqual(['60000', '10', '60000']);
  });

  it('reports a block while the block key lives', async () => {
    const storage = new RedisThrottlerStorage({
      evalScript: jest.fn<RedisEvalClient['evalScript']>().mockResolvedValue([11, 30_000, 59_500]),
    });
    const record = await storage.increment('k', 60_000, 10, 60_000, 'auth');
    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(60);
  });

  it('fails open when Redis is unreachable, so an outage does not take the API down', async () => {
    const storage = new RedisThrottlerStorage({
      evalScript: jest.fn<RedisEvalClient['evalScript']>().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const record = await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(0);
  });
});

describe('RESP framing', () => {
  it('encodes a command as an array of bulk strings', () => {
    expect(encodeCommand(['GET', 'k']).toString()).toBe('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
  });

  it('decodes integers, bulk strings, arrays and errors across chunk boundaries', () => {
    const reader = new RespReader();
    const replies: unknown[] = [];
    reader.feed(Buffer.from('*3\r\n:11\r\n:300'), (r) => replies.push(r));
    reader.feed(Buffer.from('00\r\n$-1\r\n+OK\r\n-ERR bad\r\n$2\r\nhi\r\n'), (r) => replies.push(r));
    expect(replies[0]).toEqual([11, 30_000, null]);
    expect(replies[1]).toBe('OK');
    expect(replies[2]).toBeInstanceOf(Error);
    expect((replies[2] as Error).message).toBe('ERR bad');
    expect(replies[3]).toBe('hi');
  });
});
