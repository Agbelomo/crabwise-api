/**
 * Order creation.
 *
 * The purchase flow lives in `marketplace.service` alongside the rest of the
 * marketplace surface; this module re-exports it so existing imports through
 * the `@/services` barrel and `./orders.service` keep working.
 *
 * Purchasing an artwork creates a PENDING order priced off the artwork's
 * listed price/asset, plus a platform fee. Payment capture, status
 * transitions, and delivery are out of scope — this only covers the
 * "initiate a purchase" step.
 */

export { createOrder } from './marketplace.service';
export type { CreateOrderInput, OrderSummary } from './marketplace.service';
