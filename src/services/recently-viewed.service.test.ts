import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, tryGetRedisClientMock, loggerMock, recordTrendingSignalMock } = vi.hoisted(
  () => ({
    redisMock: { set: vi.fn(), zadd: vi.fn(), zremrangebyrank: vi.fn() },
    tryGetRedisClientMock: vi.fn(),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    recordTrendingSignalMock: vi.fn(),
  }),
);

vi.mock('@/services', () => ({ prisma: {} }));
vi.mock('@/utils/logger', () => ({ logger: loggerMock }));
vi.mock('./redis.service', () => ({ tryGetRedisClient: tryGetRedisClientMock }));
vi.mock('./trending.service', () => ({ recordTrendingSignal: recordTrendingSignalMock }));

import {
  getViewRecordingMetrics,
  recordArtworkView,
  recordArtworkViewSafely,
} from './recently-viewed.service';

const metrics = () => ({ ...getViewRecordingMetrics() });

beforeEach(() => {
  vi.clearAllMocks();
  recordTrendingSignalMock.mockResolvedValue(undefined);
});

describe('recordArtworkViewSafely', () => {
  it('counts a recorded view', async () => {
    tryGetRedisClientMock.mockReturnValue(redisMock);
    redisMock.set.mockResolvedValue('OK');
    redisMock.zadd.mockResolvedValue(1);
    redisMock.zremrangebyrank.mockResolvedValue(0);
    const before = metrics();

    await recordArtworkViewSafely('user-1', 'art-1');

    expect(metrics().recorded).toBe(before.recorded + 1);
  });

  it('counts a debounced or unconfigured view as skipped, not failed', async () => {
    tryGetRedisClientMock.mockReturnValue(undefined);
    const before = metrics();

    await recordArtworkViewSafely('user-1', 'art-1');

    expect(metrics().skipped).toBe(before.skipped + 1);
    expect(metrics().failed).toBe(before.failed);
  });

  it('logs and counts a Redis failure without rejecting', async () => {
    tryGetRedisClientMock.mockReturnValue(redisMock);
    redisMock.zadd.mockRejectedValue(new Error('redis down'));
    const before = metrics();

    await expect(recordArtworkViewSafely('user-1', 'art-1')).resolves.toBeUndefined();

    expect(metrics().failed).toBe(before.failed + 1);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'artwork view recording failed',
      expect.objectContaining({ artworkId: 'art-1', message: 'redis down' }),
    );
  });
});

describe('recordArtworkView ownership (#128)', () => {
  beforeEach(() => {
    tryGetRedisClientMock.mockReturnValue(redisMock);
    redisMock.zadd.mockResolvedValue(1);
    redisMock.zremrangebyrank.mockResolvedValue(0);
    redisMock.set.mockResolvedValue('OK');
  });

  it("rejects a caller writing another user's history and touches no keys", async () => {
    await expect(
      recordArtworkView('victim-1', 'art-1', { actorId: 'attacker-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    expect(redisMock.zadd).not.toHaveBeenCalled();
    expect(redisMock.zremrangebyrank).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(recordTrendingSignalMock).not.toHaveBeenCalled();
  });

  it('rejects before checking Redis, even when Redis is not configured', async () => {
    tryGetRedisClientMock.mockReturnValue(undefined);

    await expect(
      recordArtworkView('victim-1', 'art-1', { actorId: 'attacker-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows the owner to write to their own history', async () => {
    const result = await recordArtworkView('user-1', 'art-1', { actorId: 'user-1' });

    expect(result.recorded).toBe(true);
    expect(redisMock.zadd).toHaveBeenCalledWith(
      'recently-viewed:list:user-1',
      expect.any(Number),
      'art-1',
    );
  });

  it.each([
    ['empty user id', '', 'art-1'],
    ['user id with key separator', 'victim-1:x', 'art-1'],
    ['user id with glob', 'user-*', 'art-1'],
    ['empty artwork id', 'user-1', ''],
    ['artwork id with key separator', 'user-1', 'art:victim-1'],
    ['artwork id with whitespace', 'user-1', 'art 1'],
  ])(
    "rejects %s so one id cannot address another user's keys",
    async (_label, userId, artworkId) => {
      await expect(recordArtworkView(userId, artworkId)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(redisMock.zadd).not.toHaveBeenCalled();
      expect(redisMock.set).not.toHaveBeenCalled();
    },
  );

  it('safe wrapper never writes, counts a failure, and warns on a cross-user attempt', async () => {
    const before = metrics();

    await expect(
      recordArtworkViewSafely('victim-1', 'art-1', { actorId: 'attacker-1' }),
    ).resolves.toBeUndefined();

    expect(redisMock.zadd).not.toHaveBeenCalled();
    expect(metrics().failed).toBe(before.failed + 1);
    expect(metrics().recorded).toBe(before.recorded);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'rejected cross-user recently-viewed write',
      expect.objectContaining({ userId: 'victim-1', artworkId: 'art-1' }),
    );
  });
});

describe('recordArtworkView idempotent position (#127)', () => {
  it('updates ZSET position on every view without relying on debounce', async () => {
    tryGetRedisClientMock.mockReturnValue(redisMock);
    redisMock.zadd.mockResolvedValue(1);
    redisMock.zremrangebyrank.mockResolvedValue(0);
    redisMock.set.mockResolvedValue('OK');

    await recordArtworkView('user-1', 'art-1');
    expect(redisMock.zadd).toHaveBeenCalledWith(
      'recently-viewed:list:user-1',
      expect.any(Number),
      'art-1',
    );

    // Debounced second view: still refreshes position, skips trending.
    redisMock.set.mockResolvedValue(null);
    redisMock.zadd.mockClear();
    recordTrendingSignalMock.mockClear();

    const result = await recordArtworkView('user-1', 'art-1');
    expect(result.recorded).toBe(false);
    expect(redisMock.zadd).toHaveBeenCalledTimes(1);
    expect(redisMock.zadd).toHaveBeenCalledWith(
      'recently-viewed:list:user-1',
      expect.any(Number),
      'art-1',
    );
    expect(recordTrendingSignalMock).not.toHaveBeenCalled();
  });
});
