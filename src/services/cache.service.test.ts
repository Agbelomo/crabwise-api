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

import { cached, cacheKey, getCacheMetrics, invalidateNamespace } from './cache.service';

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockReset();
  redisMock.set.mockReset();
  redisMock.del.mockReset();
  redisMock.del.mockResolvedValue(0);
  redisMock.set.mockResolvedValue('OK');
});

function metricsSnapshot(namespace: string) {
  const entry = getCacheMetrics().get(namespace);
  return { hits: 0, misses: 0, readErrors: 0, writeErrors: 0, ...entry };
}

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

describe('cached surfaces Redis failures (#125)', () => {
  it('treats a failed read as a read error and miss, never a hit', async () => {
    redisMock.get.mockRejectedValue(new Error('ECONNRESET'));
    const fetcher = vi.fn().mockResolvedValue('fresh');
    const before = metricsSnapshot('r125read');

    await expect(cached('r125read:key', 30, fetcher)).resolves.toBe('fresh');

    const after = metricsSnapshot('r125read');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(after.hits).toBe(before.hits);
    expect(after.readErrors).toBe(before.readErrors + 1);
    expect(after.misses).toBe(before.misses + 1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('read failed for r125read:key'));
  });

  it('treats a non-string reply as a read error, not a hit', async () => {
    redisMock.get.mockResolvedValue({ bogus: true });
    const fetcher = vi.fn().mockResolvedValue('fresh');
    const before = metricsSnapshot('r125type');

    await expect(cached('r125type:key', 30, fetcher)).resolves.toBe('fresh');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(metricsSnapshot('r125type').hits).toBe(before.hits);
    expect(metricsSnapshot('r125type').readErrors).toBe(before.readErrors + 1);
  });

  it('counts corrupt JSON as a read error and refetches', async () => {
    redisMock.get.mockResolvedValue('{not json');
    const fetcher = vi.fn().mockResolvedValue(1);
    const before = metricsSnapshot('r125json');

    await expect(cached('r125json:key', 30, fetcher)).resolves.toBe(1);

    expect(metricsSnapshot('r125json').readErrors).toBe(before.readErrors + 1);
    expect(redisMock.del).toHaveBeenCalledWith('r125json:key');
  });

  it('returns the fetched value but records a write error when SET throws', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockRejectedValue(new Error('READONLY'));
    const before = metricsSnapshot('r125write');

    await expect(cached('r125write:key', 30, async () => 'value')).resolves.toBe('value');

    expect(metricsSnapshot('r125write').writeErrors).toBe(before.writeErrors + 1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('write failed for r125write:key'));
  });

  it('records a write error when SET is not acknowledged with OK', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue(null);
    const before = metricsSnapshot('r125ack');

    await expect(cached('r125ack:key', 30, async () => 'value')).resolves.toBe('value');

    expect(metricsSnapshot('r125ack').writeErrors).toBe(before.writeErrors + 1);
  });

  it('does not swallow a delete failure into a fake hit', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ v: 'old', exp: Date.now() - 1 }));
    redisMock.del.mockRejectedValue(new Error('down'));
    const fetcher = vi.fn().mockResolvedValue('new');

    await expect(cached('r125del:key', 30, fetcher)).resolves.toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by the fetcher itself', async () => {
    redisMock.get.mockResolvedValue(null);

    await expect(
      cached('r125fetch:key', 30, () => Promise.reject(new Error('db down'))),
    ).rejects.toThrow('db down');
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

describe('cache domain isolation (#126)', () => {
  it('tags written envelopes with their domain', async () => {
    redisMock.get.mockResolvedValue(null);

    await cached('search:{"q":"cat"}', 30, async () => ['a'], { domain: 'search-results' });

    const stored = JSON.parse(redisMock.set.mock.calls[0][1] as string) as { d: string };
    expect(stored.d).toBe('search-results');
  });

  it("never serves another domain's entry stored under the same key", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({ v: { total: 3 }, exp: Date.now() + 60_000, d: 'search-results' }),
    );
    const fetcher = vi.fn().mockResolvedValue(['sorted']);

    const result = await cached('search:{"q":"cat"}', 30, fetcher, { domain: 'sorted-results' });

    expect(result).toEqual(['sorted']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(redisMock.set.mock.calls[0][1] as string) as { d: string };
    expect(stored.d).toBe('sorted-results');
  });

  it('defaults the domain to the key namespace', async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({ v: 1, exp: Date.now() + 60_000, d: 'reviews' }),
    );
    const fetcher = vi.fn().mockResolvedValue(2);

    await expect(cached('marketplace:trending', 30, fetcher)).resolves.toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not serve legacy untagged bare values to an explicit domain', async () => {
    redisMock.get.mockResolvedValue('5');
    const fetcher = vi.fn().mockResolvedValue(6);

    await expect(cached('ns:key', 30, fetcher, { domain: 'counts' })).resolves.toBe(6);
  });

  it('cacheKey encodes parts so they cannot forge another key', () => {
    expect(cacheKey('reviews', 'avg', 'id-1')).toBe('reviews:avg:id-1');
    expect(cacheKey('reviews', 'avg', 'x:y')).toBe('reviews:avg:x%3Ay');
    expect(cacheKey('a', 'b:c')).not.toBe(cacheKey('a', 'b', 'c'));
  });

  it.each(['', '*', 'mark*', 'a::b', 'ns:', 'a b', 'x?'])(
    'rejects unsafe namespace %j',
    async (namespace) => {
      expect(() => cacheKey(namespace, 'x')).toThrow(/Invalid cache namespace/);
      await expect(invalidateNamespace(namespace)).rejects.toThrow(/Invalid cache namespace/);
      expect(redisMock.scan).not.toHaveBeenCalled();
    },
  );

  it('accepts multi-segment namespaces such as artworks:list', async () => {
    redisMock.scan.mockResolvedValueOnce(['0', []]);

    await invalidateNamespace('artworks:list');

    expect(redisMock.scan).toHaveBeenCalledWith('0', 'MATCH', 'artworks:list:*', 'COUNT', 500);
  });
});
