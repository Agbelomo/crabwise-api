/**
 * Per-user "recently viewed" artwork tracking, stored in Redis (not the
 * database — an ephemeral, debounced signal, not a durable record).
 *
 * Also feeds the trending score (a view is a trending signal) — recording
 * a view does both in one call so callers don't have to remember to wire
 * up both separately.
 */

import type { Artwork } from '@prisma/client';

import { AppError } from '@/middlewares';
import { prisma } from '@/services';
import { logger } from '@/utils/logger';

import { recordTrendingSignal } from './trending.service';
import { tryGetRedisClient } from './redis.service';

const DEBOUNCE_TTL_SECONDS = 60 * 60;
const MAX_RECENTLY_VIEWED = 50;

function debounceKey(userId: string, artworkId: string): string {
  return `recently-viewed:debounce:${userId}:${artworkId}`;
}

function listKey(userId: string): string {
  return `recently-viewed:list:${userId}`;
}

/** Ids are opaque, but must never contain the key separator, whitespace or
 * Redis glob characters, so one id can't address another user's keys (#128). */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RecordViewOptions {
  /**
   * The authenticated caller. When supplied it must equal `userId`: a caller
   * may only write their own history (#128).
   */
  readonly actorId?: string;
}

/**
 * Ensures the history being written belongs to the caller and that both ids
 * are safe to embed in Redis keys (#128). Throws `FORBIDDEN` on an ownership
 * mismatch and `BAD_REQUEST` on a malformed id.
 */
function assertCanWriteHistory(userId: string, artworkId: string, actorId?: string): void {
  if (typeof userId !== 'string' || !SAFE_ID_PATTERN.test(userId)) {
    throw new AppError('BAD_REQUEST', 'Invalid user id');
  }
  if (typeof artworkId !== 'string' || !SAFE_ID_PATTERN.test(artworkId)) {
    throw new AppError('BAD_REQUEST', 'Invalid artwork id');
  }
  if (actorId !== undefined && actorId !== userId) {
    throw new AppError('FORBIDDEN', "Cannot record views in another user's history");
  }
}

export interface ViewRecordingMetrics {
  /** Views written to Redis. */
  recorded: number;
  /** Views intentionally not written (debounced, or Redis not configured). */
  skipped: number;
  /** Views that failed with an error (e.g. Redis unavailable). */
  failed: number;
}

const viewRecordingMetrics: ViewRecordingMetrics = { recorded: 0, skipped: 0, failed: 0 };

/** Success/skip/failure counters for view recording since process start.
 * Read by a metrics/health endpoint or logged periodically. */
export function getViewRecordingMetrics(): Readonly<ViewRecordingMetrics> {
  return viewRecordingMetrics;
}

export interface RecordViewResult {
  readonly recorded: boolean;
}

/**
 * Records a view for "recently viewed" and trending, debounced to once per
 * user per artwork per hour. A no-op when Redis isn't configured.
 *
 * Ownership is checked before anything is written (#128): when
 * `options.actorId` is given it must match `userId`, otherwise `FORBIDDEN`
 * is thrown and no Redis key is touched.
 */
export async function recordArtworkView(
  userId: string,
  artworkId: string,
  options: RecordViewOptions = {},
): Promise<RecordViewResult> {
  assertCanWriteHistory(userId, artworkId, options.actorId);
  const redis = tryGetRedisClient();
  if (redis === undefined) {
    return { recorded: false };
  }

  // #127 — always refresh position in the sorted set (idempotent member upsert).
  // Re-viewing the same artwork moves it to the front without creating a duplicate
  // entry; Redis ZADD updates the score for an existing member.
  const key = listKey(userId);
  await redis.zadd(key, Date.now(), artworkId);
  await redis.zremrangebyrank(key, 0, -(MAX_RECENTLY_VIEWED + 1));

  // Debounce only the trending side-effect so repeated views within the window
  // do not inflate trending scores, while still allowing list position updates.
  const wasSet = await redis.set(
    debounceKey(userId, artworkId),
    '1',
    'EX',
    DEBOUNCE_TTL_SECONDS,
    'NX',
  );
  if (wasSet === null) {
    return { recorded: false };
  }

  await recordTrendingSignal(artworkId, 'view');

  return { recorded: true };
}

export interface RecentlyViewedPage {
  readonly items: readonly Artwork[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
}

/** Most-recently-viewed first. Empty when Redis isn't configured. */
export async function listRecentlyViewed(
  userId: string,
  page: number,
  limit: number,
): Promise<RecentlyViewedPage> {
  const redis = tryGetRedisClient();
  if (redis === undefined) {
    return { items: [], page, limit, total: 0 };
  }

  const key = listKey(userId);
  const total = await redis.zcard(key);
  const start = (page - 1) * limit;
  const ids = await redis.zrevrange(key, start, start + limit - 1);
  if (ids.length === 0) {
    return { items: [], page, limit, total };
  }

  const artworks = await prisma.artwork.findMany({ where: { id: { in: [...ids] } } });
  const byId = new Map(artworks.map((artwork) => [artwork.id, artwork]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((artwork): artwork is Artwork => artwork !== undefined);

  return { items, page, limit, total };
}

/**
 * Fire-and-forget wrapper around `recordArtworkView` for request paths that
 * must not wait on, or fail because of, view tracking. Never rejects: failures
 * are logged at debug level and counted in `getViewRecordingMetrics`, so a
 * Redis outage is visible without affecting response latency.
 */
export async function recordArtworkViewSafely(
  userId: string,
  artworkId: string,
  options: RecordViewOptions = {},
): Promise<void> {
  try {
    const { recorded } = await recordArtworkView(userId, artworkId, options);
    if (recorded) {
      viewRecordingMetrics.recorded += 1;
    } else {
      viewRecordingMetrics.skipped += 1;
    }
  } catch (error) {
    viewRecordingMetrics.failed += 1;
    if (error instanceof AppError && error.code === 'FORBIDDEN') {
      // #128 — an attempted cross-user write is a bug or abuse, not noise.
      logger.warn('rejected cross-user recently-viewed write', { userId, artworkId });
      return;
    }
    logger.debug('artwork view recording failed', {
      artworkId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
