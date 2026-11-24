/**
 * Marketplace browse service.
 *
 * Only published, unsold artworks are ever surfaced here — this is a
 * discovery surface, not an owner-management one (see `artworks.service`
 * for that). Browse results are cached in Redis for a short TTL
 * (cache-aside: read through on a miss, write on the way out) since this is
 * the highest-traffic read path in the API; caching degrades to a no-op
 * when Redis isn't configured.
 *
 * `trending` and `recommended` both rank by the same weighted trending
 * score (see `trending.service`) and are cached for 5 minutes — "trending
 * results update within 5 minutes of activity" is satisfied by that TTL
 * rather than by pushing updates on every signal. `recommended` is
 * popularity-based at MVP (identical ranking to trending, just a separate
 * cached slot) — there's no per-user interaction history modeled yet to
 * personalize against.
 *
 * Pagination (`browseArtworks`): `newest`, `popular` and `rating` (the latter
 * two alias `newest`) use an id keyset cursor — the id of the last item, which
 * Prisma resolves against the `createdAt desc, id asc` order. `price_asc` and
 * `price_desc` order by a nullable, non-unique column, so the last item's id is
 * not a position in that order; they use an offset cursor (`o:<n>`) over the
 * total order `(price, id)` instead. A cursor is only valid for the sort that
 * produced it. Offset pages can shift if artworks are published between
 * requests; the 30-second cache bounds how often that is visible.
 *
 * This module also owns the order lookup and the purchase settlement
 * callback: a payment callback settles a PROCESSING order exactly once,
 * claiming the order and the artwork with conditional updates inside a
 * single transaction so a lost race leaves no partial state.
 */

import { Prisma, type Artwork, type ArtworkCategory, type Asset, type Order } from '@prisma/client';

import { env } from '@/config';
import { AppError } from '@/middlewares';
import { prisma } from '@/services';
import { stableStringify } from '@/utils/stable-json';

import { cached } from './cache.service';
import { tryGetRedisClient } from './redis.service';
import { getTopTrendingArtworkIds } from './trending.service';

export type MarketplaceSort = 'newest' | 'price_asc' | 'price_desc' | 'popular' | 'rating';

export interface BrowseFilters {
  readonly category?: ArtworkCategory;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly asset?: Asset;
  readonly verifiedOnly?: boolean;
}

export interface BrowsePage {
  readonly items: readonly Artwork[];
  readonly nextCursor: string | null;
}

const FEATURED_LIMIT = 10;
const TRENDING_LIMIT = 10;
const RANKING_LIMIT = 20;
const RECOMMENDED_LIMIT = 20;
const BROWSE_CACHE_TTL_SECONDS = 30;
const RANKING_CACHE_TTL_SECONDS = 5 * 60;
/** Verified-artist membership changes rarely; cache it well past the browse
 * TTL so `verifiedOnly=true` browse doesn't re-query the join every miss (#865). */
const VERIFIED_ARTISTS_CACHE_TTL_SECONDS = 15 * 60;

/**
 * User ids of every verified artist, cached under its own namespace so the
 * lookup isn't repeated on each `verifiedOnly` browse (#865). The result is
 * deliberately a plain (possibly empty) array — callers filter with
 * `userId: { in: ids }`, and an empty `in` list matches nothing, which is
 * the correct behaviour when no artist is verified yet.
 */
async function verifiedArtistUserIds(): Promise<string[]> {
  return cached('marketplace:verified-artist-ids', VERIFIED_ARTISTS_CACHE_TTL_SECONDS, async () => {
    const profiles = await prisma.artistProfile.findMany({
      where: { verified: true },
      select: { userId: true },
    });
    return profiles.map((p) => p.userId);
  });
}

/**
 * Builds the Prisma `where` for a browse request. Purely synchronous now:
 * the verified-artist ids are resolved once by the caller (so they can also
 * participate in cache-key construction) rather than being queried from
 * inside this function on every uncached miss (#865).
 */
function buildWhere(
  filters: BrowseFilters,
  verifiedIds?: readonly string[],
): Prisma.ArtworkWhereInput {
  const where: Prisma.ArtworkWhereInput = {
    published: true,
    sold: false,
  };
  if (filters.category !== undefined) {
    where.category = filters.category;
  }
  if (filters.asset !== undefined) {
    where.asset = filters.asset;
  }
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {
      ...(filters.minPrice !== undefined ? { gte: filters.minPrice } : {}),
      ...(filters.maxPrice !== undefined ? { lte: filters.maxPrice } : {}),
    };
  }
  if (filters.verifiedOnly === true) {
    where.userId = { in: [...(verifiedIds ?? [])] };
  }
  return where;
}

/**
 * `popular` and `rating` don't have a backing metric yet (no stored
 * engagement counter or artist-rating aggregate wired into this query) —
 * both currently alias to `newest` rather than silently returning an
 * unsorted/incorrect ranking. A real implementation needs a stored
 * engagement counter and a Review-rating aggregate joined by artist id.
 */
function orderBy(sort: MarketplaceSort): Prisma.ArtworkOrderByWithRelationInput[] {
  switch (sort) {
    case 'price_asc':
      return [{ price: 'asc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ price: 'desc' }, { id: 'asc' }];
    case 'newest':
    case 'popular':
    case 'rating':
    default:
      return [{ createdAt: 'desc' }, { id: 'asc' }];
  }
}

const OFFSET_CURSOR_PREFIX = 'o:';

function usesOffsetCursor(sort: MarketplaceSort): boolean {
  return sort === 'price_asc' || sort === 'price_desc';
}

function invalidCursor(): AppError {
  return new AppError('BAD_REQUEST', 'Invalid pagination cursor for this sort order');
}

function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const match = /^o:(\d+)$/.exec(cursor);
  if (match === null) {
    throw invalidCursor();
  }
  return Number.parseInt(match[1]!, 10);
}

function browseCacheKey(
  filters: BrowseFilters,
  sort: MarketplaceSort,
  cursor: string | undefined,
  limit: number,
): string {
  // `verifiedOnly` is always materialised (true/false, never undefined) so
  // "filter off" and "filter absent" share one cache slot instead of
  // producing two keys for the same result set (#865).
  const normalized = {
    ...filters,
    verifiedOnly: filters.verifiedOnly === true,
  };
  return `marketplace:browse:${stableStringify({ filters: normalized, sort, cursor, limit })}`;
}

export async function browseArtworks(
  filters: BrowseFilters,
  sort: MarketplaceSort,
  cursor: string | undefined,
  limit: number,
): Promise<BrowsePage> {
  const redis = tryGetRedisClient();
  const cacheKey = browseCacheKey(filters, sort, cursor, limit);

  if (redis !== undefined) {
    const cachedPage = await redis.get(cacheKey);
    if (cachedPage !== null) {
      return JSON.parse(cachedPage) as BrowsePage;
    }
  }

  const offsetMode = usesOffsetCursor(sort);
  if (!offsetMode && cursor?.startsWith(OFFSET_CURSOR_PREFIX)) {
    throw invalidCursor();
  }
  const offset = offsetMode ? parseOffsetCursor(cursor) : 0;
  // Resolve verified ids outside buildWhere so the same cached list feeds
  // both the filter and any future cache-key material (#865).
  const verifiedIds = filters.verifiedOnly === true ? await verifiedArtistUserIds() : undefined;
  const where = buildWhere(filters, verifiedIds);

  const items = await prisma.artwork.findMany({
    where,
    orderBy: orderBy(sort),
    take: limit + 1,
    ...(offsetMode
      ? { skip: offset }
      : cursor !== undefined
        ? { cursor: { id: cursor }, skip: 1 }
        : {}),
  });

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextCursor = !hasMore
    ? null
    : offsetMode
      ? `${OFFSET_CURSOR_PREFIX}${offset + limit}`
      : (page[page.length - 1]?.id ?? null);
  const result: BrowsePage = { items: page, nextCursor };

  if (redis !== undefined) {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', BROWSE_CACHE_TTL_SECONDS);
  }

  return result;
}

/**
 * Curated proxy for "featured": most recently published, unsold artworks.
 * There's no editorial-curation flag or rating aggregate to rank by yet.
 */
export async function listFeaturedArtworks(): Promise<readonly Artwork[]> {
  return prisma.artwork.findMany({
    where: { published: true, sold: false },
    orderBy: [{ createdAt: 'desc' }],
    take: FEATURED_LIMIT,
  });
}

/**
 * Ranks published artworks by the weighted Redis trending score, falling
 * back to `listFeaturedArtworks` when Redis isn't configured or nothing has
 * a score yet, rather than returning an empty list.
 */
async function rankedByTrendingScore(limit: number): Promise<readonly Artwork[]> {
  const ids = await getTopTrendingArtworkIds(limit);
  if (ids.length === 0) {
    return listFeaturedArtworks();
  }

  const artworks = await prisma.artwork.findMany({
    where: { id: { in: [...ids] }, published: true, sold: false },
  });
  const byId = new Map(artworks.map((artwork) => [artwork.id, artwork]));

  return ids
    .map((id) => byId.get(id))
    .filter((artwork): artwork is Artwork => artwork !== undefined);
}

/** Market place trending list (uncached) — see `getTrendingArtworks` for the cached surface. */
export async function listTrendingArtworks(): Promise<readonly Artwork[]> {
  return rankedByTrendingScore(TRENDING_LIMIT);
}

/** Top trending artworks, weighted by recent views/saves/purchases. Cached for 5 minutes. */
export async function getTrendingArtworks(): Promise<readonly Artwork[]> {
  return cached('marketplace:trending', RANKING_CACHE_TTL_SECONDS, () =>
    rankedByTrendingScore(RANKING_LIMIT),
  );
}

/** Popularity-based recommendations (MVP — see file doc comment). Cached for 5 minutes. */
export async function getRecommendedArtworks(): Promise<readonly Artwork[]> {
  return cached('marketplace:recommended', RANKING_CACHE_TTL_SECONDS, () =>
    rankedByTrendingScore(RECOMMENDED_LIMIT),
  );
}

/**
 * The only order state a purchase callback may settle from.
 *
 * Matches the schema's `PENDING → PROCESSING → COMPLETED` machine: PROCESSING
 * means payment has been observed, so completing straight from PENDING (or
 * reviving a FAILED/REFUNDED order) is rejected rather than skipping a step.
 */
const SETTLEABLE_ORDER_STATUS = 'PROCESSING';

export interface PurchaseCallbackResult {
  readonly order: Order;
  /** True when the callback repeated an already-settled purchase. */
  readonly duplicate: boolean;
}

function orderNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Order not found');
}

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/**
 * Fetches an order by id. An unknown identifier (or a row removed between the
 * lookup and the read) becomes the stable NOT_FOUND error, while any other
 * failure is rethrown untouched so callers can tell a missing order apart from
 * an infrastructure problem (#57).
 */
export async function getMarketplaceOrder(orderId: string): Promise<Order> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order === null) {
      throw orderNotFound();
    }
    return order;
  } catch (err) {
    if (isRecordNotFound(err)) {
      throw orderNotFound();
    }
    throw err;
  }
}

/**
 * Settles a purchase once its payment has been observed (PROCESSING →
 * COMPLETED): completes the order, marks the artwork sold, and writes the
 * buyer's PURCHASE ledger entry.
 *
 * Every write happens inside one transaction, and the order and artwork are
 * claimed with conditional updates. If either claim loses a race (another
 * callback already completed the order, or another order sold the artwork),
 * the method throws and the transaction rolls back, so a failed conditional
 * update never leaves the order, artwork, or ledger half-updated (#59).
 *
 * A repeat callback for an already-completed order is a no-op that reports
 * `duplicate: true`; the artwork flag and ledger row are only written on the
 * first settlement (#56).
 */
export async function completeMarketplacePurchase(
  orderId: string,
  txHash: string,
): Promise<PurchaseCallbackResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (order === null) {
      throw orderNotFound();
    }

    // Replayed callback: the purchase is already settled, so report the
    // existing order without running any side effect a second time.
    if (order.status === 'COMPLETED') {
      return { order, duplicate: true };
    }

    if (order.status !== SETTLEABLE_ORDER_STATUS) {
      throw new AppError('CONFLICT', `Cannot complete an order in ${order.status} state`);
    }

    // Claim the order only while it is still PROCESSING. A concurrent callback
    // that won the race makes this a no-op instead of completing twice.
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: SETTLEABLE_ORDER_STATUS },
      data: { status: 'COMPLETED', txHash },
    });
    if (claimed.count === 0) {
      throw new AppError('CONFLICT', 'Order was already settled by another request');
    }

    // An artwork can only be sold once. If a competing order sold it first,
    // throwing here rolls back the order claim above.
    const reserved = await tx.artwork.updateMany({
      where: { id: order.artworkId, sold: false },
      data: { sold: true },
    });
    if (reserved.count === 0) {
      throw new AppError('CONFLICT', 'Artwork is no longer available for purchase');
    }

    await tx.transaction.create({
      data: {
        orderId: order.id,
        userId: order.buyerId,
        type: 'PURCHASE',
        amount: order.amount,
        asset: order.asset,
        txHash,
        network: env.stellarNetwork,
        confirmed: true,
      },
    });

    const settled: Order = { ...order, status: 'COMPLETED', txHash };
    return { order: settled, duplicate: false };
  });
}
