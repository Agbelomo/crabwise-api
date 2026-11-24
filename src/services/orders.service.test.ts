import { Prisma, type Order, type OrderStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/middlewares';

const { prismaMock, loggerMock } = vi.hoisted(() => {
  const prisma = {
    artwork: { findUnique: vi.fn() },
    order: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { prismaMock: prisma, loggerMock: logger };
});

vi.mock('@/services', () => ({ prisma: prismaMock }));
vi.mock('@/utils', () => ({ logger: loggerMock }));

import { createOrder, transitionOrderStatus } from './orders.service';

const BUYER_ID = 'buyer-1';
const SELLER_ID = 'seller-1';
const ARTWORK_ID = 'artwork-1';
const ORDER_ID = 'order-1';

function makeArtwork(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ARTWORK_ID,
    userId: SELLER_ID,
    title: 'Sunset',
    published: true,
    sold: false,
    price: new Prisma.Decimal('100.00'),
    asset: 'XLM',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Record<string, unknown>> = {}): Order {
  return {
    id: ORDER_ID,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
    artworkId: ARTWORK_ID,
    amount: new Prisma.Decimal('100.00'),
    asset: 'XLM',
    platformFee: new Prisma.Decimal('5.00'),
    status: 'PENDING',
    idempotencyKey: null,
    txHash: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as Order;
}

function knownRequestError(
  code: string,
  message = 'database error',
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createOrder — party identity (#55)', () => {
  beforeEach(() => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.order.findFirst.mockResolvedValue(null);
    prismaMock.order.create.mockResolvedValue(makeOrder());
  });

  it('uses the authenticated buyer and the artwork owner as the seller', async () => {
    const summary = await createOrder(BUYER_ID, { artworkId: ARTWORK_ID });

    const { data } = prismaMock.order.create.mock.calls[0]![0];
    expect(data.buyerId).toBe(BUYER_ID);
    expect(data.sellerId).toBe(SELLER_ID);
    expect(summary.order.buyerId).toBe(BUYER_ID);
    expect(summary.order.sellerId).toBe(SELLER_ID);
  });

  it('ignores party ids supplied alongside the order input', async () => {
    await createOrder(BUYER_ID, {
      artworkId: ARTWORK_ID,
      buyerId: 'attacker-buyer',
      sellerId: 'attacker-seller',
    } as never);

    const { data } = prismaMock.order.create.mock.calls[0]![0];
    expect(data.buyerId).toBe(BUYER_ID);
    expect(data.sellerId).toBe(SELLER_ID);
  });

  it('rejects purchasing an artwork the caller owns', async () => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork({ userId: BUYER_ID }));

    await expect(createOrder(BUYER_ID, { artworkId: ARTWORK_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prismaMock.order.create).not.toHaveBeenCalled();
  });

  it('returns the original order — parties included — for an idempotent retry', async () => {
    const existing = makeOrder({ idempotencyKey: 'key-1', status: 'PROCESSING' });
    prismaMock.order.findUnique.mockResolvedValue(existing);

    const summary = await createOrder(BUYER_ID, {
      artworkId: ARTWORK_ID,
      idempotencyKey: 'key-1',
    });

    expect(summary.order).toBe(existing);
    expect(summary.order.buyerId).toBe(BUYER_ID);
    expect(summary.order.sellerId).toBe(SELLER_ID);
    expect(prismaMock.order.create).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key already used for a different artwork', async () => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ artworkId: 'other-artwork' }));

    await expect(
      createOrder(BUYER_ID, { artworkId: ARTWORK_ID, idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('transitionOrderStatus — state machine (#58)', () => {
  const allowed: ReadonlyArray<[OrderStatus, OrderStatus]> = [
    ['PENDING', 'PROCESSING'],
    ['PROCESSING', 'COMPLETED'],
    ['COMPLETED', 'REFUNDED'],
    ['PENDING', 'FAILED'],
    ['PROCESSING', 'FAILED'],
  ];

  it.each(allowed)('allows %s -> %s', async (from, to) => {
    const current = makeOrder({ status: from });
    const updated = makeOrder({ status: to });
    prismaMock.order.findUnique.mockResolvedValueOnce(current).mockResolvedValueOnce(updated);
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await transitionOrderStatus(ORDER_ID, to);

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: from },
      data: { status: to },
    });
    expect(result.previousStatus).toBe(from);
    expect(result.order.status).toBe(to);
  });

  it('rejects completing an order without the payment/processing step', async () => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));

    await expect(transitionOrderStatus(ORDER_ID, 'COMPLETED')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        currentStatus: 'PENDING',
        requestedStatus: 'COMPLETED',
        allowedTransitions: ['PROCESSING', 'FAILED'],
      },
    });
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['COMPLETED', 'PROCESSING'],
    ['COMPLETED', 'FAILED'],
    ['FAILED', 'PROCESSING'],
    ['REFUNDED', 'COMPLETED'],
    ['REFUNDED', 'REFUNDED'],
    ['PENDING', 'PENDING'],
    ['PENDING', 'REFUNDED'],
  ] as ReadonlyArray<[OrderStatus, OrderStatus]>)('rejects %s -> %s', async (from, to) => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ status: from }));

    await expect(transitionOrderStatus(ORDER_ID, to)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for an order that does not exist', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null);

    await expect(transitionOrderStatus('missing-order', 'PROCESSING')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a transition when another request changed the status first', async () => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(transitionOrderStatus(ORDER_ID, 'PROCESSING')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('exposes the same rules through the predicate', async () => {
    const { isOrderStatusTransitionAllowed } = await import('./orders.service');

    expect(isOrderStatusTransitionAllowed('PENDING', 'PROCESSING')).toBe(true);
    expect(isOrderStatusTransitionAllowed('PENDING', 'COMPLETED')).toBe(false);
    expect(isOrderStatusTransitionAllowed('REFUNDED', 'COMPLETED')).toBe(false);
  });
});

describe('stable client-facing order errors (#60)', () => {
  beforeEach(() => {
    prismaMock.artwork.findUnique.mockResolvedValue(makeArtwork());
    prismaMock.order.findFirst.mockResolvedValue(null);
  });

  it('does not leak the internal database message when creation fails', async () => {
    const internal = knownRequestError(
      'P2010',
      'Raw query failed. postgresql://app:secret@db:5432/app is unreachable',
    );
    prismaMock.order.create.mockRejectedValue(internal);

    const failure = await createOrder(BUYER_ID, { artworkId: ARTWORK_ID }).catch((err) => err);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(failure.message).toBe('Could not complete the order. Please try again.');
    expect(failure.message).not.toContain('secret');
    expect(failure.cause).toBe(internal);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'orders: failed to create',
      expect.objectContaining({ name: internal.name }),
    );
  });

  it('reports a duplicate idempotency key as a conflict, not an internal error', async () => {
    prismaMock.order.create.mockRejectedValue(knownRequestError('P2002'));
    // The racing request's row is not visible yet, so the replay lookup misses.
    prismaMock.order.findUnique.mockResolvedValue(null);

    await expect(
      createOrder(BUYER_ID, { artworkId: ARTWORK_ID, idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This idempotency key has already been used',
    });
  });

  it('keeps transition persistence failures generic while logging the cause', async () => {
    const internal = new Error('connection terminated unexpectedly');
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));
    prismaMock.order.updateMany.mockRejectedValue(internal);

    const failure = await transitionOrderStatus(ORDER_ID, 'PROCESSING').catch((err) => err);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Could not update the order status. Please try again.',
    });
    expect(failure.cause).toBe(internal);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'orders: failed to transition',
      expect.objectContaining({ message: internal.message }),
    );
  });
});
