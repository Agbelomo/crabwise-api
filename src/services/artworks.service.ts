/**
 * Artwork CRUD, publishing-workflow, listing and detail service.
 *
 * Listings are the highest-traffic read in the API, so they're cached
 * (cache-aside, 5-minute TTL — the "stale data within a 5-minute window"
 * budget named in the caching issue). Mutations that change what a listing
 * shows (create, update, publish/unpublish, delete) invalidate the
 * `artworks:list` namespace, so the 5-minute window is only the worst case for
 * changes made outside this service (e.g. an artwork being marked sold).
 *
 * Listing filters compose: category, price range and search are independent
 * constraints that are ANDed together (see `listingWhere`), and the cache key
 * is derived from the same normalized filters so two requests that mean the
 * same thing share one entry.
 *
 * Prices never pass through `Number()` in this service: `Decimal(12, 2)`
 * columns are fed either the original decimal string or a `Prisma.Decimal`,
 * which keeps cent-level values exact.
 */

import { Prisma, type Asset, type Artwork, type ArtworkCategory } from '@prisma/client';

import { AppError } from '@/middlewares';
import { prisma } from '@/services';
import { stableStringify } from '@/utils/stable-json';

import { cached, invalidateNamespace } from './cache.service';
import { recordArtworkViewSafely } from './recently-viewed.service';

/**
 * Any value Prisma accepts for a `Decimal` column (#47). Callers that know
 * the exact amount should pass a string (or `Prisma.Decimal`): a JS `number`
 * is already a binary float, whereas a string is handed to Decimal untouched
 * so `19.99` cannot drift to `19.989999999999998`.
 */
export type DecimalValue = Prisma.Decimal.Value;

export interface ListArtworksFilters {
  readonly category?: ArtworkCategory;
  /** Inclusive minimum price. */
  readonly minPrice?: DecimalValue;
  /** Inclusive maximum price. */
  readonly maxPrice?: DecimalValue;
  /** Case-insensitive term matched against the title and description. */
  readonly search?: string;
}

export interface ArtworkPage {
  readonly items: readonly Artwork[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
}

const LISTING_CACHE_TTL_SECONDS = 5 * 60;
const LISTING_CACHE_NAMESPACE = 'artworks:list';
const ARTWORK_NOT_FOUND = 'Artwork not found';

/**
 * Normalizes a price without altering its digits: `Decimal` instances are
 * kept as-is and strings are parsed by Decimal directly. Numbers are only
 * widened (they cannot be un-rounded), which is why they're the least precise
 * accepted form. Never convert back to `Number` — that is what corrupts
 * decimal prices (#47).
 */
function toDecimal(value: DecimalValue | undefined): Prisma.Decimal | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Deterministic, plain form of the filters used for both the cache key and
 * the query, so the two can never disagree about what a filter means (#48).
 * Prices are stringified after normalization, which also collapses `19.90`
 * and `19.9` into the same cache entry. Whitespace-only search terms are
 * treated as absent.
 */
interface CanonicalListingFilters {
  readonly category?: ArtworkCategory;
  readonly minPrice?: string;
  readonly maxPrice?: string;
  readonly search?: string;
}

function canonicalListingFilters(filters: ListArtworksFilters): CanonicalListingFilters {
  const minPrice = toDecimal(filters.minPrice);
  const maxPrice = toDecimal(filters.maxPrice);
  const search = filters.search?.trim();
  return {
    ...(filters.category !== undefined ? { category: filters.category } : {}),
    ...(minPrice !== undefined ? { minPrice: minPrice.toString() } : {}),
    ...(maxPrice !== undefined ? { maxPrice: maxPrice.toString() } : {}),
    ...(search !== undefined && search !== '' ? { search } : {}),
  };
}

/**
 * Builds the listing predicate. Each filter occupies its own top-level key,
 * so category, price and search combine with AND and none of them overwrites
 * another. Search is an `OR` across the searchable columns inside its own
 * branch — it widens matches without relaxing the other filters (#48).
 */
function listingWhere(filters: ListArtworksFilters): Prisma.ArtworkWhereInput {
  const where: Prisma.ArtworkWhereInput = {
    published: true,
    sold: false,
  };
  const canonical = canonicalListingFilters(filters);

  if (canonical.category !== undefined) {
    where.category = canonical.category;
  }
  if (canonical.minPrice !== undefined || canonical.maxPrice !== undefined) {
    where.price = {
      ...(canonical.minPrice !== undefined ? { gte: new Prisma.Decimal(canonical.minPrice) } : {}),
      ...(canonical.maxPrice !== undefined ? { lte: new Prisma.Decimal(canonical.maxPrice) } : {}),
    };
  }
  if (canonical.search !== undefined) {
    where.OR = [
      { title: { contains: canonical.search, mode: 'insensitive' } },
      { description: { contains: canonical.search, mode: 'insensitive' } },
    ];
  }
  return where;
}

function listingCacheKey(filters: ListArtworksFilters, page: number, limit: number): string {
  return `${LISTING_CACHE_NAMESPACE}:${stableStringify({
    filters: canonicalListingFilters(filters),
    page,
    limit,
  })}`;
}

export async function listPublishedArtworks(
  filters: ListArtworksFilters,
  page: number,
  limit: number,
): Promise<ArtworkPage> {
  // Built once and shared by the rows and the count query, so a page can never
  // report a total that was computed with a different predicate (#48).
  const where = listingWhere(filters);

  return cached(listingCacheKey(filters, page, limit), LISTING_CACHE_TTL_SECONDS, async () => {
    const [items, total] = await Promise.all([
      prisma.artwork.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.artwork.count({ where }),
    ]);

    return { items, page, limit, total };
  });
}

export interface CreateArtworkInput {
  readonly title: string;
  readonly description?: string;
  readonly category: ArtworkCategory;
  readonly tags?: readonly string[];
  readonly price?: DecimalValue;
  readonly asset?: Asset;
}

export interface UpdateArtworkInput {
  readonly title?: string;
  readonly description?: string;
  readonly category?: ArtworkCategory;
  readonly tags?: readonly string[];
  readonly price?: DecimalValue;
  readonly asset?: Asset;
}

function artworkNotFound(): AppError {
  return new AppError('NOT_FOUND', ARTWORK_NOT_FOUND);
}

/**
 * A write that follows an ownership lookup can still find nothing: another
 * request can delete the artwork in between. Prisma reports that as `P2025`
 * ("record to update/delete not found"), which would otherwise surface as an
 * internal error. Resolve both paths to the same stable not-found result.
 */
async function withArtworkNotFound<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw artworkNotFound();
    }
    throw err;
  }
}

async function findOwnedArtwork(userId: string, artworkId: string) {
  const artwork = await prisma.artwork.findUnique({ where: { id: artworkId } });
  if (artwork === null) {
    throw artworkNotFound();
  }
  if (artwork.userId !== userId) {
    throw new AppError('FORBIDDEN', 'You do not own this artwork');
  }
  return artwork;
}

/** Duplicate titles are allowed — there's no uniqueness constraint on title. */
export async function createArtwork(userId: string, input: CreateArtworkInput) {
  const artwork = await prisma.artwork.create({
    data: {
      userId,
      title: input.title,
      description: input.description,
      category: input.category,
      tags: input.tags ?? undefined,
      price: toDecimal(input.price),
      asset: input.asset,
    },
  });
  await invalidateNamespace(LISTING_CACHE_NAMESPACE);
  return artwork;
}

export async function updateArtwork(userId: string, artworkId: string, input: UpdateArtworkInput) {
  await findOwnedArtwork(userId, artworkId);
  const artwork = await withArtworkNotFound(() =>
    prisma.artwork.update({
      where: { id: artworkId },
      data: {
        title: input.title,
        description: input.description,
        category: input.category,
        tags: input.tags === undefined ? undefined : input.tags,
        price: input.price,
        asset: input.asset,
      },
    }),
  );
  const artwork = await prisma.artwork.update({
    // Ownership is part of the write predicate, not just the check above: a
    // concurrent ownership change cannot slip an update onto another user's
    // row, and a missing row surfaces as P2025 instead of silently updating
    // whatever now holds that id (#49).
    where: { id: artworkId, userId },
    data: {
      title: input.title,
      description: input.description,
      category: input.category,
      tags: input.tags === undefined ? undefined : input.tags,
      price: toDecimal(input.price),
      asset: input.asset,
    },
  });
  await invalidateNamespace(LISTING_CACHE_NAMESPACE);
  return artwork;
}

export async function getArtworkById(artworkId: string): Promise<Artwork> {
  const artwork = await prisma.artwork.findUnique({ where: { id: artworkId } });
  if (artwork === null) {
    throw artworkNotFound();
  }
  return artwork;
}

/**
 * Flips the published flag. Publishing (false → true) requires at least one
 * attached media record — an artwork with no images shouldn't go live.
 * Unpublishing has no such requirement.
 */
export async function setArtworkPublished(userId: string, artworkId: string, published: boolean) {
  const artwork = await findOwnedArtwork(userId, artworkId);

  if (published && !artwork.published) {
    const mediaCount = await prisma.artworkMedia.count({ where: { artworkId } });
    if (mediaCount === 0) {
      throw new AppError(
        'UNPROCESSABLE_ENTITY',
        'Cannot publish an artwork with no media attached.',
      );
    }
  }

  const updated = await withArtworkNotFound(() =>
    prisma.artwork.update({ where: { id: artworkId }, data: { published } }),
  );
  await invalidateNamespace(LISTING_CACHE_NAMESPACE);
  return updated;
}

export async function deleteArtwork(userId: string, artworkId: string): Promise<void> {
  await findOwnedArtwork(userId, artworkId);
  await withArtworkNotFound(() => prisma.artwork.delete({ where: { id: artworkId } }));
  await invalidateNamespace(LISTING_CACHE_NAMESPACE);
}

export interface ReviewSummary {
  readonly averageRating: number | null;
  readonly count: number;
}

export interface ArtworkDetail {
  readonly artwork: Artwork;
  /**
   * The artwork's owner. `null` when the row carries no creator reference, so
   * the detail shape stays stable instead of omitting the key (#50).
   */
  readonly creatorId: string | null;
  /** Always an array, even when the artwork has no media (#50). */
  readonly mediaIds: readonly string[];
  /** Always an array, even when no same-category artwork exists (#50). */
  readonly relatedArtworks: readonly Artwork[];
  /** Always present; both fields have neutral defaults when unrated (#50). */
  readonly reviewSummary: ReviewSummary;
}

const RELATED_ARTWORKS_LIMIT = 6;

/**
 * "License" isn't a modeled concept in this schema (no License field/table)
 * — not included here rather than guessed at. Review summary aggregates
 * `Review.rating` where `targetId` is the artwork's owner (the artist),
 * since reviews target sellers, not individual artworks.
 *
 * Optional relations (creator, category, media) are normalized rather than
 * assumed: a missing owner becomes `null`, and absent media/related artworks
 * become empty arrays. Artworks with no category match produce no related
 * items instead of an error (#50).
 */
export async function getArtworkDetail(
  artworkId: string,
  viewerId: string | undefined,
): Promise<ArtworkDetail> {
  const artwork = await getArtworkById(artworkId);

  // Public detail is a discovery surface like the listing endpoints, so it
  // applies the same visibility rule: an unpublished draft or an artwork that
  // has already been sold is reported as not found rather than exposed (#45).
  if (!artwork.published || artwork.sold) {
    throw new AppError('NOT_FOUND', 'Artwork not found');
  }

  const [mediaLinks, relatedArtworks, reviewAggregate] = await Promise.all([
    prisma.artworkMedia.findMany({ where: { artworkId }, orderBy: { sort: 'asc' } }),
    prisma.artwork.findMany({
      where: {
        category: artwork.category,
        published: true,
        sold: false,
        id: { not: artworkId },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: RELATED_ARTWORKS_LIMIT,
    }),
    prisma.review.aggregate({
      where: { targetId: artwork.userId },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  // View-count increment is fire-and-forget (async, debounced per viewer) —
  // detail responses shouldn't wait on it or fail the request if Redis is
  // briefly unavailable. Failures are logged and counted, not thrown.
  if (viewerId !== undefined) {
    void recordArtworkViewSafely(viewerId, artworkId);
  }

  return {
    artwork,
    creatorId: artwork.userId ?? null,
    mediaIds: (mediaLinks ?? []).map((link) => link.mediaId),
    relatedArtworks: relatedArtworks ?? [],
    reviewSummary: {
      averageRating: reviewAggregate?._avg?.rating ?? null,
      count: reviewAggregate?._count?.rating ?? 0,
    },
  };
}
