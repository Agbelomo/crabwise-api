import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  },
}));

vi.mock('./redis.service', () => ({
  tryGetRedisClient: () => redisMock,
}));

import { cached, invalidateNamespace } from './cache.service';

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.del.mockResolvedValue(0);
  redisMock.set.mockResolvedValue('OK');
});

describe('invalidateNamespace (#866)', () => {
  it('uses SCAN (never KEYS) and deletes matched keys in batches', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => `marketplace:key-${i}`);
    const page2 = Array.from({ length: 30 }, (_, i) => `marketplace:key-${500 + i}`);

    redisMock.scan
      .mockResolvedValueOnce(['123', page1])
      .mockResolvedValueOnce(['456', page2])
      .mockResolvedValueOnce(['0', []]);

    await invalidateNamespace('marketplace');

    expect(redisMock.scan).toHaveBeenCalledTimes(3);
    for (const [cursor, ...rest] of redisMock.scan.mock.calls) {
      expect(cursor).toBeDefined();
      expect(rest).toContain('MATCH');
      expect(rest).toContain('marketplace:*');
    }
    expect(redisMock).not.toHaveProperty('keys');
    expect(redisMock.del).toHaveBeenCalledTimes(2);
    expect(redisMock.del.mock.calls[0]).toHaveLength(500);
    expect(redisMock.del.mock.calls[1]).toHaveLength(30);
  });

  it('issues a single trailing DEL for a small keyspace', async () => {
    redisMock.scan.mockResolvedValueOnce(['0', ['marketplace:a', 'marketplace:b']]);

    await invalidateNamespace('marketplace');

    expect(redisMock.del).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith('marketplace:a', 'marketplace:b');
  });

  it('does not call DEL when the namespace has no keys', async () => {
    redisMock.scan.mockResolvedValueOnce(['0', []]);

    await invalidateNamespace('marketplace');

    expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe('cached TTL expiry (#124)', () => {
  it('treats expired envelopes as misses, deletes the key, and refreshes', async () => {
    const expired = JSON.stringify({ v: { stale: true }, exp: Date.now() - 1000 });
    redisMock.get.mockResolvedValueOnce(expired).mockResolvedValueOnce(null);
    const fetcher = vi.fn().mockResolvedValue({ fresh: true });

    const result = await cached('ns:key', 30, fetcher);

    expect(result).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith('ns:key');
    expect(redisMock.set).toHaveBeenCalledWith(
      'ns:key',
      expect.stringContaining('"fresh":true'),
      'EX',
      30,
    );
    const stored = JSON.parse(redisMock.set.mock.calls[0][1] as string) as {
      v: unknown;
      exp: number;
    };
    expect(stored.v).toEqual({ fresh: true });
    expect(stored.exp).toBeGreaterThan(Date.now());
  });

  it('serves a non-expired envelope as a hit without calling fetcher', async () => {
    const live = JSON.stringify({ v: 42, exp: Date.now() + 60_000 });
    redisMock.get.mockResolvedValue(live);
    const fetcher = vi.fn();

    await expect(cached('ns:key', 30, fetcher)).resolves.toBe(42);
    expect(fetcher).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});
