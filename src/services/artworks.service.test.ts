import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/middlewares';

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    artwork: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    artworkMedia: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    review: {
      aggregate: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

const { cachedMock, invalidateNamespaceMock } = vi.hoisted(() => ({
  cachedMock: vi.fn(async (_key: string, _ttl: number, fetcher: () => Promise<unknown>) =>
    fetcher(),
  ),
  invalidateNamespaceMock: vi.fn(),
}));

vi.mock('@/services', () => ({ prisma: prismaMock }));
vi.mock('./cache.service', () => ({
  cached: cachedMock,
  invalidateNamespace: invalidateNamespaceMock,
}));

import {
  createArtwork,
  deleteArtwork,
  getArtworkById,
  getArtworkDetail,
  listPublishedArtworks,
  setArtworkPublished,
  updateArtwork,
} from './artworks.service';

const OWNER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const ARTWORK_ID = 'artwork-1';

function makeArtwork(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ARTWORK_ID,
    userId: OWNER_ID,
    title: 'Sunset',
    description: null,
    category: 'DIGITAL_PAINTING',
    tags: null,
    coverMediaId: null,
    price: null,
    asset: null,
    published: false,
    sold: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** The error Prisma raises when the row a write targets no longer exists. */
function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
    code: 'P2025',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createArtwork', () => {
  it('creates an artwork owned by the caller', async () => {
    prismaMock.artwork.create.mockResolvedValue(makeArtwork());

    await createArtwork(OWNER_ID, { title: 'Sunset', category: 'DIGITAL_PAINTING' as never });

    const { data } = prismaMock.artwork.create.mock.calls[0]![0];
    expect(data.userId).toBe(OWNER_ID);
    expect(data.title).toBe('Sunset');
  });

  it('allows duplicate titles — no uniqueness constraint on title', async () => {
    prismaMock.artwork.create.mockResolvedValueOnce(makeArtwork({ id: 'artwork-1' }));
    prismaMock.artwork.create.mockResolvedValueOnce(makeArtwork({ id: 'artwork-2' }));

    const first = await createArtwork(OWNER_ID, {
      title: 'Sunset',
      category: 'DIGITAL_PAINTING' as never,
    });
    const second = await createArtwork(OWNER_ID, {
      title: 'Sunset',
      category: 'DIGITAL_PAINTING' as never,
    });

    expect(first.id).not.toBe(second.id);
    expect(prismaMock.artwork.create).toHaveBeenCalledTimes(2);
  });
});

describe('updateArtwork', () => {
  it('rejects updates from a non-owner', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ userId: OWNER_ID }));

    await expect(
      updateArtwork(OTHER_USER_ID, ARTWORK_ID, { title: 'New title' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prismaMock.artwork.update).not.toHaveBeenCalled();
  });

  it('rejects updates to a missing artwork', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(null);

    await expect(
      updateArtwork(OWNER_ID, 'missing-id', { title: 'New title' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updates an artwork owned by the caller', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.update.mockResolvedValue(makeArtwork({ title: 'New title' }));

    const updated = await updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'New title' });

    expect(updated.title).toBe('New title');
    expect(prismaMock.artwork.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ARTWORK_ID, userId: OWNER_ID } }),
    );
  });
});

describe('updateArtwork — ownership is part of the write predicate (#49)', () => {
  it('scopes the update itself to the caller, not just the lookup', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ userId: OWNER_ID }));
    prismaMock.artwork.update.mockResolvedValue(makeArtwork({ userId: OWNER_ID }));

    await updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'New title' });

    const [args] = prismaMock.artwork.update.mock.calls[0]!;
    expect(args.where).toEqual({ id: ARTWORK_ID, userId: OWNER_ID });
  });

  it('fails when ownership changes between the pre-check and the write', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ userId: OWNER_ID }));
    prismaMock.artwork.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: '6.19.3',
      }),
    );

    await expect(updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'New title' })).rejects.toMatchObject(
      { code: 'P2025' },
    );
    // A rejected write must not invalidate the listing cache.
    expect(invalidateNamespaceMock).not.toHaveBeenCalled();
  });
});

describe('price precision (#47)', () => {
  it('stores a string price as the exact decimal instead of a float', async () => {
    prismaMock.artwork.create.mockResolvedValue(makeArtwork());

    await createArtwork(OWNER_ID, {
      title: 'Sunset',
      category: 'DIGITAL_PAINTING' as never,
      price: '19.99',
    });

    const { price } = prismaMock.artwork.create.mock.calls[0]![0].data;
    expect(price).toBeInstanceOf(Prisma.Decimal);
    expect(price.toString()).toBe('19.99');
    // Decimal arithmetic stays exact — the same sum as JS numbers does not.
    expect(price.plus('0.01').toString()).toBe('20');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('preserves every digit of a max-scale Decimal price', async () => {
    prismaMock.artwork.create.mockResolvedValue(makeArtwork());

    await createArtwork(OWNER_ID, {
      title: 'Sunset',
      category: 'DIGITAL_PAINTING' as never,
      price: '9999999999.99',
    });

    const { price } = prismaMock.artwork.create.mock.calls[0]![0].data;
    expect(price.toFixed(2)).toBe('9999999999.99');
  });

  it('forwards an existing Prisma.Decimal unchanged', async () => {
    prismaMock.artwork.create.mockResolvedValue(makeArtwork());
    const exact = new Prisma.Decimal('1234.56');

    await createArtwork(OWNER_ID, {
      title: 'Sunset',
      category: 'DIGITAL_PAINTING' as never,
      price: exact,
    });

    expect(prismaMock.artwork.create.mock.calls[0]![0].data.price).toBe(exact);
  });

  it('keeps update prices exact and leaves the price untouched when omitted', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.update.mockResolvedValue(makeArtwork());

    await updateArtwork(OWNER_ID, ARTWORK_ID, { price: '0.10' });
    const first = prismaMock.artwork.update.mock.calls[0]![0].data.price;
    expect(first.toString()).toBe('0.1');

    await updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'No price' });
    expect(prismaMock.artwork.update.mock.calls[1]![0].data.price).toBeUndefined();
  });

  it('keeps price range bounds exact in the listing filter', async () => {
    prismaMock.artwork.findMany.mockResolvedValue([]);
    prismaMock.artwork.count.mockResolvedValue(0);

    await listPublishedArtworks({ minPrice: '0.10', maxPrice: '9999999999.99' }, 1, 20);

    const { price } = prismaMock.artwork.findMany.mock.calls[0]![0].where;
    expect(price.gte).toBeInstanceOf(Prisma.Decimal);
    expect(price.gte.toString()).toBe('0.1');
    expect(price.lte.toFixed(2)).toBe('9999999999.99');
  });
});

describe('listPublishedArtworks — filter composition (#48)', () => {
  beforeEach(() => {
    prismaMock.artwork.findMany.mockResolvedValue([]);
    prismaMock.artwork.count.mockResolvedValue(0);
  });

  it('composes category, price range, and search into one AND predicate', async () => {
    await listPublishedArtworks(
      {
        category: 'PHOTOGRAPHY' as never,
        minPrice: '10.50',
        maxPrice: '99.99',
        search: ' sunset ',
      },
      1,
      20,
    );

    const where = prismaMock.artwork.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      published: true,
      sold: false,
      category: 'PHOTOGRAPHY',
      price: { gte: new Prisma.Decimal('10.50'), lte: new Prisma.Decimal('99.99') },
      OR: [
        { title: { contains: 'sunset', mode: 'insensitive' } },
        { description: { contains: 'sunset', mode: 'insensitive' } },
      ],
    });
  });

  it('queries items and total with the same predicate so no valid results are dropped', async () => {
    await listPublishedArtworks({ category: 'ART' as never, search: 'harbour' }, 2, 10);

    expect(prismaMock.artwork.findMany.mock.calls[0]![0].where).toEqual(
      prismaMock.artwork.count.mock.calls[0]![0].where,
    );
  });

  it('only applies the filters that were provided', async () => {
    await listPublishedArtworks({ search: 'harbour' }, 1, 20);

    const where = prismaMock.artwork.findMany.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty('category');
    expect(where).not.toHaveProperty('price');
    expect(where.OR).toEqual([
      { title: { contains: 'harbour', mode: 'insensitive' } },
      { description: { contains: 'harbour', mode: 'insensitive' } },
    ]);
  });

  it('applies a one-sided price range without inventing the other bound', async () => {
    await listPublishedArtworks({ minPrice: '5' }, 1, 20);
    expect(prismaMock.artwork.findMany.mock.calls[0]![0].where.price).toEqual({
      gte: new Prisma.Decimal('5'),
    });

    await listPublishedArtworks({ maxPrice: '50' }, 1, 20);
    expect(prismaMock.artwork.findMany.mock.calls[1]![0].where.price).toEqual({
      lte: new Prisma.Decimal('50'),
    });
  });

  it('ignores an empty or whitespace-only search term', async () => {
    await listPublishedArtworks({ search: '   ' }, 1, 20);

    const where = prismaMock.artwork.findMany.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty('OR');
  });

  it('gives distinct filter combinations distinct cache entries', async () => {
    await listPublishedArtworks({ category: 'PHOTOGRAPHY' as never }, 1, 20);
    await listPublishedArtworks({ category: 'ART' as never }, 1, 20);
    await listPublishedArtworks({ category: 'PHOTOGRAPHY' as never }, 1, 20);
    await listPublishedArtworks({ category: 'PHOTOGRAPHY' as never }, 2, 20);
    await listPublishedArtworks({ category: 'PHOTOGRAPHY' as never, minPrice: '1' }, 1, 20);
    await listPublishedArtworks({ category: 'PHOTOGRAPHY' as never, search: 'sunset' }, 1, 20);

    const keys = cachedMock.mock.calls.map(([key]) => key);
    // The third call repeats the first filter set and must reuse its entry;
    // every other combination is distinct.
    expect(keys[2]).toBe(keys[0]);
    expect(new Set([keys[0], keys[1], keys[3], keys[4], keys[5]]).size).toBe(5);
  });

  it('shares one cache entry for filters that are equivalent', async () => {
    await listPublishedArtworks({ minPrice: '10.50', search: '  sunset ' }, 1, 20);
    await listPublishedArtworks({ minPrice: new Prisma.Decimal('10.50'), search: 'sunset' }, 1, 20);

    const [first, second] = cachedMock.mock.calls.map(([key]) => key);
    expect(second).toBe(first);
  });
});

describe('getArtworkById', () => {
  it('throws NOT_FOUND for a missing artwork', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(null);

    await expect(getArtworkById('missing-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the artwork when found', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());

    const artwork = await getArtworkById(ARTWORK_ID);

    expect(artwork.id).toBe(ARTWORK_ID);
  });
});

describe('setArtworkPublished — publishing workflow', () => {
  it('rejects publishing an artwork with no media', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: false }));
    prismaMock.artworkMedia.count.mockResolvedValue(0);

    await expect(setArtworkPublished(OWNER_ID, ARTWORK_ID, true)).rejects.toBeInstanceOf(AppError);
    await expect(setArtworkPublished(OWNER_ID, ARTWORK_ID, true)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    });
    expect(prismaMock.artwork.update).not.toHaveBeenCalled();
  });

  it('publishes an artwork that has at least one media record', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: false }));
    prismaMock.artworkMedia.count.mockResolvedValue(1);
    prismaMock.artwork.update.mockResolvedValue(makeArtwork({ published: true }));

    const result = await setArtworkPublished(OWNER_ID, ARTWORK_ID, true);

    expect(result.published).toBe(true);
  });

  it('allows unpublishing regardless of media count', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: true }));
    prismaMock.artwork.update.mockResolvedValue(makeArtwork({ published: false }));

    await setArtworkPublished(OWNER_ID, ARTWORK_ID, false);

    expect(prismaMock.artworkMedia.count).not.toHaveBeenCalled();
    expect(prismaMock.artwork.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { published: false } }),
    );
  });

  it('rejects publishing by a non-owner', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ userId: OWNER_ID }));

    await expect(setArtworkPublished(OTHER_USER_ID, ARTWORK_ID, true)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('deleteArtwork', () => {
  it('rejects deleting a missing artwork', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(null);

    await expect(deleteArtwork(OWNER_ID, 'missing-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects deleting an artwork owned by someone else', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ userId: OWNER_ID }));

    await expect(deleteArtwork(OTHER_USER_ID, ARTWORK_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prismaMock.artwork.delete).not.toHaveBeenCalled();
  });

  it('deletes an artwork owned by the caller', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.delete.mockResolvedValue(makeArtwork());

    await deleteArtwork(OWNER_ID, ARTWORK_ID);

    expect(prismaMock.artwork.delete).toHaveBeenCalledWith({ where: { id: ARTWORK_ID } });
  });
});

describe('artworks removed between lookup and write', () => {
  it('returns NOT_FOUND when an artwork disappears before an update is written', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.update.mockRejectedValue(recordNotFound());

    await expect(updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'New title' })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
    expect(invalidateNamespaceMock).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when an artwork disappears before publish state is written', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: true }));
    prismaMock.artwork.update.mockRejectedValue(recordNotFound());

    await expect(setArtworkPublished(OWNER_ID, ARTWORK_ID, false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(invalidateNamespaceMock).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when an artwork disappears before it is deleted', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.delete.mockRejectedValue(recordNotFound());

    await expect(deleteArtwork(OWNER_ID, ARTWORK_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(invalidateNamespaceMock).not.toHaveBeenCalled();
  });

  it('does not translate unrelated database failures into not-found', async () => {
    const failure = new Error('connection terminated unexpectedly');
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.update.mockRejectedValue(failure);

    await expect(updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'New title' })).rejects.toBe(failure);
describe('getArtworkDetail — relation consistency (#50)', () => {
  beforeEach(() => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: true }));
    prismaMock.artwork.findMany.mockResolvedValue([]);
    prismaMock.artworkMedia.findMany.mockResolvedValue([]);
    prismaMock.review.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 0 },
    });
  });

  it('returns empty collections and a neutral summary when optional relations are missing', async () => {
    prismaMock.artworkMedia.findMany.mockResolvedValue([]);
    prismaMock.artwork.findMany.mockResolvedValue([]);

    const detail = await getArtworkDetail(ARTWORK_ID, undefined);

    expect(detail.creatorId).toBe(OWNER_ID);
    expect(detail.mediaIds).toEqual([]);
    expect(detail.relatedArtworks).toEqual([]);
    expect(detail.reviewSummary).toEqual({ averageRating: null, count: 0 });
  });

  it('keeps the detail shape stable when the creator and category are absent', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(
      makeArtwork({ userId: undefined, category: undefined, published: true }),
    );
    prismaMock.artworkMedia.findMany.mockResolvedValue(undefined as never);
    prismaMock.artwork.findMany.mockResolvedValue(undefined as never);
    prismaMock.review.aggregate.mockResolvedValue(undefined as never);

    const detail = await getArtworkDetail(ARTWORK_ID, undefined);

    expect(detail.creatorId).toBeNull();
    expect(detail.mediaIds).toEqual([]);
    expect(detail.relatedArtworks).toEqual([]);
    expect(detail.reviewSummary).toEqual({ averageRating: null, count: 0 });
  });

  it('preserves media order and related artworks when the relations exist', async () => {
    const related = makeArtwork({ id: 'artwork-2', title: 'Harbour' });
    prismaMock.artworkMedia.findMany.mockResolvedValue([
      { artworkId: ARTWORK_ID, mediaId: 'media-1', sort: 0 },
      { artworkId: ARTWORK_ID, mediaId: 'media-2', sort: 1 },
    ]);
    prismaMock.artwork.findMany.mockResolvedValue([related]);
    prismaMock.review.aggregate.mockResolvedValue({
      _avg: { rating: 4.5 },
      _count: { rating: 2 },
    });

    const detail = await getArtworkDetail(ARTWORK_ID, undefined);

    expect(detail.mediaIds).toEqual(['media-1', 'media-2']);
    expect(detail.relatedArtworks).toEqual([related]);
    expect(detail.reviewSummary).toEqual({ averageRating: 4.5, count: 2 });
    expect(prismaMock.artworkMedia.findMany).toHaveBeenCalledWith({
      where: { artworkId: ARTWORK_ID },
      orderBy: { sort: 'asc' },
    });
    expect(prismaMock.artwork.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          category: 'DIGITAL_PAINTING',
          published: true,
          id: { not: ARTWORK_ID },
        },
      }),
    );
  });
});

describe('listing cache invalidation', () => {
  beforeEach(() => {
    invalidateNamespaceMock.mockReset().mockResolvedValue(undefined);
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.artwork.create.mockResolvedValue(makeArtwork());
    prismaMock.artwork.update.mockResolvedValue(makeArtwork({ published: true }));
    prismaMock.artwork.delete.mockResolvedValue(makeArtwork());
    prismaMock.artworkMedia.count.mockResolvedValue(1);
  });

  it('invalidates the listing cache when an artwork is created', async () => {
    await createArtwork(OWNER_ID, { title: 'Sunset', category: 'DIGITAL_PAINTING' });
    expect(invalidateNamespaceMock).toHaveBeenCalledWith('artworks:list');
  });

  it('invalidates the listing cache when an artwork is updated', async () => {
    await updateArtwork(OWNER_ID, ARTWORK_ID, { title: 'New title' });
    expect(invalidateNamespaceMock).toHaveBeenCalledWith('artworks:list');
  });

  it('invalidates the listing cache on publish and unpublish', async () => {
    await setArtworkPublished(OWNER_ID, ARTWORK_ID, true);
    await setArtworkPublished(OWNER_ID, ARTWORK_ID, false);
    expect(invalidateNamespaceMock).toHaveBeenCalledTimes(2);
    expect(invalidateNamespaceMock).toHaveBeenCalledWith('artworks:list');
  });

  it('invalidates the listing cache when an artwork is deleted', async () => {
    await deleteArtwork(OWNER_ID, ARTWORK_ID);
    expect(invalidateNamespaceMock).toHaveBeenCalledWith('artworks:list');
  });

  it('does not invalidate when the mutation is rejected', async () => {
    await expect(deleteArtwork(OTHER_USER_ID, ARTWORK_ID)).rejects.toBeInstanceOf(AppError);
    expect(invalidateNamespaceMock).not.toHaveBeenCalled();
  });
});

describe('getArtworkDetail — public visibility filtering', () => {
  beforeEach(() => {
    prismaMock.artworkMedia.findMany.mockResolvedValue([]);
    prismaMock.artwork.findMany.mockResolvedValue([]);
    prismaMock.review.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 0 },
    });
  });

  it('returns the detail for a published, unsold artwork', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: true, sold: false }));

    const detail = await getArtworkDetail(ARTWORK_ID, undefined);

    expect(detail.artwork.id).toBe(ARTWORK_ID);
  });

  it('hides an unpublished artwork behind the same not-found response as a missing one', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: false, sold: false }));

    await expect(getArtworkDetail(ARTWORK_ID, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prismaMock.artworkMedia.findMany).not.toHaveBeenCalled();
    expect(prismaMock.review.aggregate).not.toHaveBeenCalled();
  });

  it('hides an already-sold artwork', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: true, sold: true }));

    await expect(getArtworkDetail(ARTWORK_ID, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('excludes unpublished and sold artworks from related results', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ published: true, sold: false }));

    await getArtworkDetail(ARTWORK_ID, undefined);

    expect(prismaMock.artwork.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          category: 'DIGITAL_PAINTING',
          published: true,
          sold: false,
          id: { not: ARTWORK_ID },
        }),
      }),
    );
  });
});
