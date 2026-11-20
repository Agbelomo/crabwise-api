import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, redisMock, envMock, enqueueEmailMock } = vi.hoisted(() => {
  const notification = {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  };
  const user = { findUnique: vi.fn() };
  return {
    prismaMock: { notification, user },
    redisMock: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
    envMock: {
      smtp: undefined as { host: string; port: number; user?: string; pass?: string } | undefined,
    },
    enqueueEmailMock: vi.fn(),
  };
});

vi.mock('@/config', () => ({ env: envMock }));
vi.mock('@/services/prisma.service', () => ({ prisma: prismaMock }));
vi.mock('./redis.service', () => ({ tryGetRedisClient: () => redisMock }));
vi.mock('@/queues', () => ({ enqueueNotificationEmail: enqueueEmailMock }));

import {
  MAX_NOTIFICATIONS_PAGE_SIZE,
  createNotification,
  createNotifications,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications.service';

const USER_ID = 'user-1';

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    userId: USER_ID,
    type: 'ORDER_UPDATE',
    data: { orderId: 'order-1' },
    readAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.smtp = undefined;
  redisMock.del.mockResolvedValue(0);
  enqueueEmailMock.mockResolvedValue(undefined);
  prismaMock.notification.findFirst.mockResolvedValue(null);
});

describe('createNotification (#841)', () => {
  it('creates a notification row and invalidates the unread-count cache', async () => {
    prismaMock.notification.create.mockResolvedValue(makeNotification());

    const result = await createNotification({
      userId: USER_ID,
      type: 'ORDER_UPDATE',
      data: { orderId: 'order-1' },
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, type: 'ORDER_UPDATE', data: { orderId: 'order-1' } },
    });
    expect(result.id).toBe('notif-1');
    expect(redisMock.del).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it('enqueues an email when SMTP is configured', async () => {
    envMock.smtp = { host: 'smtp.test', port: 587 };
    // Echo the input, as the real row would.
    prismaMock.notification.create.mockImplementation(({ data }: { data: object }) => ({
      ...makeNotification(),
      ...data,
    }));
    prismaMock.user.findUnique.mockResolvedValue({ email: 'a@b.co' });

    await createNotification({ userId: USER_ID, type: 'SYSTEM', data: { message: 'hi' } });

    expect(enqueueEmailMock).toHaveBeenCalledWith({
      to: 'a@b.co',
      type: 'SYSTEM',
      notificationId: 'notif-1',
      data: { message: 'hi' },
    });
  });

  it('still persists the notification when the recipient email lookup fails', async () => {
    envMock.smtp = { host: 'smtp.test', port: 587 };
    prismaMock.notification.create.mockResolvedValue(makeNotification());
    prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));

    await expect(createNotification({ userId: USER_ID, type: 'SYSTEM' })).resolves.toMatchObject({
      id: 'notif-1',
    });
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});

describe('createNotifications batch (#841)', () => {
  it('creates one row per recipient in a single round-trip', async () => {
    prismaMock.notification.createMany.mockResolvedValue({ count: 2 });

    const count = await createNotifications(['u1', 'u2'], 'COMMISSION_UPDATE', {
      commissionId: 'c1',
    });

    expect(count).toBe(2);
    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', type: 'COMMISSION_UPDATE', data: { commissionId: 'c1' } },
        { userId: 'u2', type: 'COMMISSION_UPDATE', data: { commissionId: 'c1' } },
      ],
    });
    expect(redisMock.del).toHaveBeenCalledTimes(2);
  });

  it('short-circuits for an empty recipient list', async () => {
    const count = await createNotifications([], 'SYSTEM');
    expect(count).toBe(0);
    expect(prismaMock.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('listNotifications (#842)', () => {
  it('paginates newest-first and reports unread count', async () => {
    prismaMock.notification.findMany.mockResolvedValue([makeNotification()]);
    prismaMock.notification.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');

    const page = await listNotifications(USER_ID, { page: 1, limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(7);
    expect(page.hasNext).toBe(false);
    expect(page.unreadCount).toBe(3);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('applies the unreadOnly filter', async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);
    prismaMock.notification.count.mockResolvedValue(0);
    redisMock.get.mockResolvedValue('0');

    await listNotifications(USER_ID, { page: 1, limit: 20, unreadOnly: true });

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, readAt: null } }),
    );
  });
});

describe('markNotificationRead (#842)', () => {
  it('stamps readAt and invalidates the unread cache', async () => {
    prismaMock.notification.findUnique
      .mockResolvedValueOnce(makeNotification({ readAt: null }))
      .mockResolvedValueOnce(makeNotification({ readAt: new Date('2026-10-02T00:00:00.000Z') }));
    prismaMock.notification.updateMany.mockResolvedValue({ count: 1 });

    const result = await markNotificationRead(USER_ID, 'notif-1');

    expect(result.readAt).not.toBeNull();
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'notif-1', userId: USER_ID, readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(redisMock.del).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`);
  });

  it('is idempotent — an already-read notification keeps its timestamp', async () => {
    const readAt = new Date('2026-10-02T00:00:00.000Z');
    prismaMock.notification.findUnique.mockResolvedValue(makeNotification({ readAt }));

    const result = await markNotificationRead(USER_ID, 'notif-1');

    expect(result.readAt).toEqual(readAt);
    expect(prismaMock.notification.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it("rejects another user's notification with NOT_FOUND", async () => {
    prismaMock.notification.findUnique.mockResolvedValue(makeNotification({ userId: 'other' }));

    await expect(markNotificationRead(USER_ID, 'notif-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('markAllNotificationsRead (#842)', () => {
  it('bulk-updates unread rows and invalidates the cache', async () => {
    prismaMock.notification.updateMany.mockResolvedValue({ count: 4 });

    const result = await markAllNotificationsRead(USER_ID);

    expect(result.updated).toBe(4);
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(redisMock.del).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`);
  });
});

describe('getUnreadCount (#842)', () => {
  it('serves the count from cache when present', async () => {
    // Legacy bare number still honored; envelope form preferred by writer.
    redisMock.get.mockResolvedValue('5');

    await expect(getUnreadCount(USER_ID)).resolves.toBe(5);
    expect(prismaMock.notification.count).not.toHaveBeenCalled();
  });

  it('serves envelope-cached unread counts', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ v: 7, exp: Date.now() + 60_000 }));

    await expect(getUnreadCount(USER_ID)).resolves.toBe(7);
    expect(prismaMock.notification.count).not.toHaveBeenCalled();
  });

  it('falls back to a COUNT query and caches the result', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
    prismaMock.notification.count.mockResolvedValue(9);

    await expect(getUnreadCount(USER_ID)).resolves.toBe(9);
    expect(redisMock.set).toHaveBeenCalledWith(
      `notifications:unread:${USER_ID}`,
      expect.stringContaining('"v":9'),
      'EX',
      60,
    );
  });
});

describe('createNotification idempotency by eventKey (#119)', () => {
  it('returns the existing notification without creating a duplicate when the same eventKey is used', async () => {
    const existing = makeNotification({ id: 'notif-existing', eventKey: 'evt-abc' });
    prismaMock.notification.findFirst.mockResolvedValue(existing);

    const result = await createNotification({
      userId: USER_ID,
      type: 'ORDER_UPDATE',
      eventKey: 'evt-abc',
    });

    expect(result.id).toBe('notif-existing');
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
  });

  it('creates a new notification when no matching eventKey exists', async () => {
    prismaMock.notification.findFirst.mockResolvedValue(null);
    prismaMock.notification.create.mockResolvedValue(makeNotification({ eventKey: 'evt-new' }));

    const result = await createNotification({
      userId: USER_ID,
      type: 'ORDER_UPDATE',
      eventKey: 'evt-new',
    });

    expect(prismaMock.notification.create).toHaveBeenCalled();
    expect(result.id).toBe('notif-1');
  });

  it('skips the deduplication lookup when no eventKey is supplied', async () => {
    prismaMock.notification.create.mockResolvedValue(makeNotification());

    await createNotification({ userId: USER_ID, type: 'ORDER_UPDATE' });

    expect(prismaMock.notification.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalled();
  });
});

describe('markNotificationRead recipient ownership (#120)', () => {
  it("rejects access to another user's notification with NOT_FOUND", async () => {
    prismaMock.notification.findUnique.mockResolvedValue(
      makeNotification({ userId: 'other-user' }),
    );

    await expect(markNotificationRead(USER_ID, 'notif-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prismaMock.notification.update).not.toHaveBeenCalled();
  });

  it('allows the owner to mark their own notification read', async () => {
    prismaMock.notification.findUnique
      .mockResolvedValueOnce(makeNotification({ readAt: null }))
      .mockResolvedValueOnce(makeNotification({ readAt: new Date('2026-10-02T00:00:00.000Z') }));
    prismaMock.notification.updateMany.mockResolvedValue({ count: 1 });

    const result = await markNotificationRead(USER_ID, 'notif-1');

    expect(result.readAt).not.toBeNull();
    expect(prismaMock.notification.updateMany).toHaveBeenCalled();
  });
});

describe('listNotifications ordering (#123)', () => {
  it('orders by createdAt desc then id desc for stable pagination', async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);
    prismaMock.notification.count.mockResolvedValue(0);
    redisMock.get.mockResolvedValue('0');

    await listNotifications(USER_ID, { page: 1, limit: 20 });

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});

describe('listNotifications pagination validation (#122)', () => {
  beforeEach(() => {
    prismaMock.notification.findMany.mockResolvedValue([]);
    prismaMock.notification.count.mockResolvedValue(0);
    redisMock.get.mockResolvedValue('0');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s page without querying', async (_label, page) => {
    await expect(listNotifications(USER_ID, { page, limit: 20 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled();
    expect(prismaMock.notification.count).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 10.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above the cap', MAX_NOTIFICATIONS_PAGE_SIZE + 1],
    ['huge', 1_000_000],
  ])('rejects a %s limit without returning unbounded data', async (_label, limit) => {
    await expect(listNotifications(USER_ID, { page: 1, limit })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled();
  });

  it('rejects a page whose offset would overflow a safe integer', async () => {
    await expect(
      listNotifications(USER_ID, { page: Number.MAX_SAFE_INTEGER, limit: 100 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled();
  });

  it('accepts the boundary values and passes a bounded take/skip', async () => {
    await listNotifications(USER_ID, { page: 3, limit: MAX_NOTIFICATIONS_PAGE_SIZE });

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 200, take: MAX_NOTIFICATIONS_PAGE_SIZE }),
    );
  });

  it('accepts the minimum page and limit', async () => {
    await listNotifications(USER_ID, { page: 1, limit: 1 });

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 1 }),
    );
  });
});

describe('markNotificationRead idempotent side effects (#121)', () => {
  it('does not invalidate unread cache when already read', async () => {
    const readAt = new Date('2026-01-01T00:00:00.000Z');
    prismaMock.notification.findUnique.mockResolvedValue(makeNotification({ id: 'n1', readAt }));

    await markNotificationRead(USER_ID, 'n1');

    expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});
