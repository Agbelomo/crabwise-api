/**
 * Order creation and status transitions.
 *
 * The purchase flow lives in `marketplace.service` alongside the rest of the
 * marketplace surface; this module re-exports it so existing imports through
 * the `@/services` barrel and `./orders.service` keep working.
 *
 * Purchasing an artwork creates a PENDING order priced off the artwork's
 * listed price/asset, plus a platform fee. Payment capture and delivery are
 * out of scope here — payment intents are built in `stellar-payment.service`,
 * and fulfillment flips the status through `transitionOrderStatus`.
 *
 * Both parties are pinned at creation time: the buyer is the authenticated
 * caller and the seller is the artwork's owner as read from the database, so
 * request input can never choose them.
 */

import { Prisma, type Artwork, type Order, type OrderStatus } from '@prisma/client';

import { env } from '@/config';
import { AppError } from '@/middlewares';
import { prisma } from '@/services';
import { logger } from '@/utils';
import { calculatePlatformFee } from '@/utils/fee';

export interface CreateOrderInput {
  readonly artworkId: string;
  readonly idempotencyKey?: string;
}

export interface OrderSummary {
  readonly order: Order;
  readonly total: string;
}

export interface OrderTransitionResult {
  readonly order: Order;
  readonly previousStatus: OrderStatus;
}

/** Order statuses that mean "this purchase already exists" — a new attempt
 * for the same buyer/artwork is rejected rather than creating a second
 * order. FAILED/REFUNDED orders don't block a retry. */
const BLOCKING_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED'] as const;

/**
 * The order state machine documented with the schema: payment must move an
 * order through PROCESSING before it can be COMPLETED, and only a completed
 * order can be refunded. FAILED and REFUNDED are terminal, so a payment
 * cannot be replayed against an order that already ended.
 */
const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ['PROCESSING', 'FAILED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['REFUNDED'],
  FAILED: [],
  REFUNDED: [],
};

const ORDER_ERROR_MESSAGES = {
  create: 'Could not complete the order. Please try again.',
  transition: 'Could not update the order status. Please try again.',
} as const;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Logs the underlying persistence failure server-side, then returns a stable
 * client-facing error. Internal messages (driver text, query values,
 * connection details) stay in the log and out of the response body.
 */
function orderPersistenceFailure(
  action: keyof typeof ORDER_ERROR_MESSAGES,
  err: unknown,
): AppError {
  logger.error(`orders: failed to ${action}`, {
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
  });
  return new AppError('INTERNAL_ERROR', ORDER_ERROR_MESSAGES[action], { cause: err });
}

/**
 * Freezes the two parties of a purchase. The buyer is always the
 * authenticated caller; the seller is always the artwork's owner. Neither is
 * read from request input, and storing both on the order keeps the deal
 * intact if the artwork later changes hands.
 */
function orderPartiesFor(
  buyerId: string,
  artwork: Artwork,
): { readonly buyerId: string; readonly sellerId: string } {
  if (artwork.userId === buyerId) {
    throw new AppError('FORBIDDEN', 'You cannot purchase your own artwork');
  }
  return { buyerId, sellerId: artwork.userId };
}

function toSummary(order: Order): OrderSummary {
  return { order, total: order.amount.add(order.platformFee).toFixed(2) };
}

export async function createOrder(buyerId: string, input: CreateOrderInput): Promise<OrderSummary> {
  const artwork = await prisma.artwork.findUnique({ where: { id: input.artworkId } });
  if (artwork === null) {
    throw new AppError('NOT_FOUND', 'Artwork not found');
  }
  const parties = orderPartiesFor(buyerId, artwork);
  if (!artwork.published || artwork.sold) {
    throw new AppError('UNPROCESSABLE_ENTITY', 'Artwork is not available for purchase');
  }
  if (artwork.price === null || artwork.asset === null) {
    throw new AppError('UNPROCESSABLE_ENTITY', 'Artwork has no price set');
  }

  if (input.idempotencyKey !== undefined) {
    const existing = await prisma.order.findUnique({
      where: { buyerId_idempotencyKey: { buyerId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing !== null) {
      if (existing.artworkId !== input.artworkId) {
        throw new AppError('CONFLICT', 'Idempotency key was already used for another artwork');
      }
      return toSummary(existing);
    }
  }

  const duplicate = await prisma.order.findFirst({
    where: { buyerId, artworkId: input.artworkId, status: { in: [...BLOCKING_STATUSES] } },
  });
  if (duplicate !== null) {
    throw new AppError('CONFLICT', 'You already have an order for this artwork');
  }

  const platformFee = calculatePlatformFee(artwork.price, env.platformFeeBps);

  try {
    const order = await prisma.order.create({
      data: {
        buyerId: parties.buyerId,
        sellerId: parties.sellerId,
        artworkId: artwork.id,
        amount: artwork.price,
        asset: artwork.asset,
        platformFee,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return toSummary(order);
  } catch (err) {
    // A concurrent request with the same idempotency key won the race —
    // return its order instead of failing this one.
    if (input.idempotencyKey !== undefined && isUniqueViolation(err)) {
      const raced = await prisma.order.findUnique({
        where: { buyerId_idempotencyKey: { buyerId, idempotencyKey: input.idempotencyKey } },
      });
      if (raced !== null) {
        return toSummary(raced);
      }
      throw new AppError('CONFLICT', 'This idempotency key has already been used');
    }
    throw orderPersistenceFailure('create', err);
  }
}

export function isOrderStatusTransitionAllowed(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Applies an order status transition, rejecting transitions that skip a
 * required payment or fulfillment step. The write is conditional on the
 * status that was read, so two concurrent callbacks can't both apply a
 * transition from the same state.
 */
export async function transitionOrderStatus(
  orderId: string,
  nextStatus: OrderStatus,
): Promise<OrderTransitionResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (order === null) {
    throw new AppError('NOT_FOUND', 'Order not found');
  }

  const allowedTransitions = ORDER_STATUS_TRANSITIONS[order.status];
  if (!allowedTransitions.includes(nextStatus)) {
    throw new AppError('CONFLICT', `Order cannot move from ${order.status} to ${nextStatus}`, {
      details: {
        currentStatus: order.status,
        requestedStatus: nextStatus,
        allowedTransitions,
      },
    });
  }

  let applied: { readonly count: number };
  try {
    applied = await prisma.order.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: nextStatus },
    });
  } catch (err) {
    throw orderPersistenceFailure('transition', err);
  }

  if (applied.count === 0) {
    throw new AppError('CONFLICT', 'Order status changed during the transition; reload and retry', {
      details: {
        currentStatus: order.status,
        requestedStatus: nextStatus,
      },
    });
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  if (updated === null) {
    throw new AppError('NOT_FOUND', 'Order not found');
  }

  return { order: updated, previousStatus: order.status };
}
 * listed price/asset, plus a platform fee. Payment capture, status
 * transitions, and delivery are out of scope — this only covers the
 * "initiate a purchase" step.
 */

export { createOrder } from './marketplace.service';
export type { CreateOrderInput, OrderSummary } from './marketplace.service';
