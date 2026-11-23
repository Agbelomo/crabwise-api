import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMMISSION_ID = 'commission-1';
const CLIENT_ID = 'client-1';
const ARTIST_ID = 'artist-1';

const { prismaMock, enqueueMock, buildIntentMock, loggerMock } = vi.hoisted(() => ({
  prismaMock: {
    commission: { findUnique: vi.fn() },
    commissionRefund: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    notification: { createMany: vi.fn() },
  },
  enqueueMock: vi.fn(),
  buildIntentMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/queues', () => ({ enqueueCommissionRefund: enqueueMock }));
vi.mock('@/services/stellar-payment.service', () => ({
  buildCommissionRefundIntent: buildIntentMock,
}));
vi.mock('@/utils', () => ({ logger: loggerMock }));
vi.mock('@/services/prisma.service', () => ({ prisma: prismaMock }));

import { processCommissionRefund, scheduleCommissionRefund } from './commission-refund.service';

function makeCommission() {
  return {
    id: COMMISSION_ID,
    clientId: CLIENT_ID,
    artistId: ARTIST_ID,
    asset: 'USDC' as const,
    status: 'CANCELLED',
  };
}

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: 'refund-1',
    commissionId: COMMISSION_ID,
    amount: '450.00',
    asset: 'USDC',
    status: 'PENDING',
    xdr: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.commission.findUnique.mockResolvedValue(makeCommission());
  prismaMock.commissionRefund.findUnique.mockResolvedValue(makeRefund());
  prismaMock.commissionRefund.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.commissionRefund.update.mockResolvedValue(makeRefund({ status: 'COMPLETED' }));
  prismaMock.notification.createMany.mockResolvedValue({ count: 2 });
  enqueueMock.mockResolvedValue(undefined);
  buildIntentMock.mockResolvedValue({
    commissionId: COMMISSION_ID,
    xdr: 'AAAA-encoded-xdr',
    networkPassphrase: 'Test SDF Network ; September 2015',
    expiresAt: '2026-10-15T12:00:00.000Z',
    amount: '450.00',
    asset: 'USDC',
    source: 'GESCROW',
    destination: 'GCLIENT',
  });
});

describe('scheduleCommissionRefund (#874)', () => {
  const tx = {
    commissionRefund: { upsert: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tx.commissionRefund.upsert.mockResolvedValue(makeRefund());
    enqueueMock.mockResolvedValue(undefined);
  });

  it('upserts a PENDING refund row and enqueues a background job', async () => {
    const amount = { toFixed: () => '450.00' };

    await scheduleCommissionRefund(tx as never, makeCommission(), amount);

    expect(tx.commissionRefund.upsert).toHaveBeenCalledWith({
      where: { commissionId: COMMISSION_ID },
      create: {
        commissionId: COMMISSION_ID,
        amount: '450.00',
        asset: 'USDC',
        status: 'PENDING',
      },
      update: {},
    });
    expect(enqueueMock).toHaveBeenCalledWith({
      commissionId: COMMISSION_ID,
      refundId: 'refund-1',
    });
  });

  it('does not re-enqueue when the refund is no longer PENDING', async () => {
    tx.commissionRefund.upsert.mockResolvedValue(makeRefund({ status: 'COMPLETED' }));

    await scheduleCommissionRefund(tx as never, makeCommission(), {
      toFixed: () => '450.00',
    });

    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe('processCommissionRefund (#874)', () => {
  it('claims the refund, builds the intent, and marks it COMPLETED', async () => {
    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('COMPLETED');
    expect(prismaMock.commissionRefund.updateMany).toHaveBeenCalledWith({
      where: { commissionId: COMMISSION_ID, status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    expect(buildIntentMock).toHaveBeenCalled();
    expect(prismaMock.commissionRefund.update).toHaveBeenCalledWith({
      where: { commissionId: COMMISSION_ID },
      data: { status: 'COMPLETED', xdr: 'AAAA-encoded-xdr', lastError: null },
    });
    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: CLIENT_ID,
          type: 'COMMISSION_REFUND_PROCESSED',
          data: expect.objectContaining({ refundStatus: 'COMPLETED', amount: '450.00' }),
        }),
        expect.objectContaining({ userId: ARTIST_ID, type: 'COMMISSION_REFUND_PROCESSED' }),
      ],
    });
  });

  it('is idempotent — a non-PENDING refund is skipped without rebuilding', async () => {
    prismaMock.commissionRefund.findUnique.mockResolvedValue(
      makeRefund({ status: 'COMPLETED', xdr: 'already-built' }),
    );

    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('SKIPPED_ALREADY_PROCESSED');
    expect(buildIntentMock).not.toHaveBeenCalled();
    expect(prismaMock.commissionRefund.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.commissionRefund.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.createMany).not.toHaveBeenCalled();
  });

  it('reprocessing a completed refund does not issue another payment or change its result (#77)', async () => {
    prismaMock.commissionRefund.findUnique.mockResolvedValue(
      makeRefund({ status: 'COMPLETED', xdr: 'already-built-xdr' }),
    );

    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('SKIPPED_ALREADY_PROCESSED');
    expect(buildIntentMock).not.toHaveBeenCalled();
    expect(prismaMock.commissionRefund.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.commissionRefund.update).not.toHaveBeenCalled();
  });

  it('loses the claim race gracefully when another worker got there first', async () => {
    prismaMock.commissionRefund.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('SKIPPED_ALREADY_PROCESSED');
    expect(buildIntentMock).not.toHaveBeenCalled();
  });

  it('skips when the commission no longer exists', async () => {
    prismaMock.commission.findUnique.mockResolvedValue(null);

    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('SKIPPED_NOT_REQUIRED');
    expect(buildIntentMock).not.toHaveBeenCalled();
  });

  it('skips when there is no refund row', async () => {
    prismaMock.commissionRefund.findUnique.mockResolvedValue(null);

    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('SKIPPED_NOT_REQUIRED');
  });

  it('marks FAILED with the error and notifies both parties before re-throwing', async () => {
    buildIntentMock.mockRejectedValue(new Error('Horizon unreachable'));

    await expect(processCommissionRefund(COMMISSION_ID)).rejects.toThrow('Horizon unreachable');

    expect(prismaMock.commissionRefund.update).toHaveBeenCalledWith({
      where: { commissionId: COMMISSION_ID },
      data: { status: 'FAILED', lastError: 'Horizon unreachable' },
    });
    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          type: 'COMMISSION_REFUND_FAILED',
          data: expect.objectContaining({ error: 'Horizon unreachable' }),
        }),
      ]),
    });
  });

  it('avoids marking a refund complete before payment succeeds (#80)', async () => {
    const callOrder: string[] = [];

    prismaMock.commissionRefund.updateMany.mockImplementation(async () => {
      callOrder.push('CLAIM_PROCESSING');
      return { count: 1 };
    });

    buildIntentMock.mockImplementation(async () => {
      callOrder.push('BUILD_PAYMENT_INTENT');
      return {
        commissionId: COMMISSION_ID,
        xdr: 'AAAA-encoded-xdr',
        networkPassphrase: 'Test SDF Network ; September 2015',
        expiresAt: '2026-10-15T12:00:00.000Z',
        amount: '450.00',
        asset: 'USDC',
        source: 'GESCROW',
        destination: 'GCLIENT',
      };
    });

    prismaMock.commissionRefund.update.mockImplementation(async ({ data }: { data: { status: string } }) => {
      callOrder.push(`UPDATE_${data.status}`);
      return makeRefund({ status: data.status });
    });

    const outcome = await processCommissionRefund(COMMISSION_ID);

    expect(outcome).toBe('COMPLETED');
    expect(callOrder).toEqual(['CLAIM_PROCESSING', 'BUILD_PAYMENT_INTENT', 'UPDATE_COMPLETED']);
  });

  it('tests state order around failed payment submission — never marks complete on error (#80)', async () => {
    const callOrder: string[] = [];

    prismaMock.commissionRefund.updateMany.mockImplementation(async () => {
      callOrder.push('CLAIM_PROCESSING');
      return { count: 1 };
    });

    buildIntentMock.mockImplementation(async () => {
      callOrder.push('BUILD_PAYMENT_INTENT_FAILED');
      throw new Error('Horizon submission error');
    });

    prismaMock.commissionRefund.update.mockImplementation(async ({ data }: { data: { status: string } }) => {
      callOrder.push(`UPDATE_${data.status}`);
      return makeRefund({ status: data.status });
    });

    await expect(processCommissionRefund(COMMISSION_ID)).rejects.toThrow('Horizon submission error');

    expect(callOrder).toEqual(['CLAIM_PROCESSING', 'BUILD_PAYMENT_INTENT_FAILED', 'UPDATE_FAILED']);
    expect(prismaMock.commissionRefund.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });
});
