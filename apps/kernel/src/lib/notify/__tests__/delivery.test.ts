/**
 * Tests for the `delivered_at` claim/release guard (#2044).
 *
 * This is the mutual-exclusion primitive a live push (ws-push.ts) and a
 * backlog replay (backlog.ts) both rely on to never deliver the same
 * notification twice: the atomic `UPDATE ... WHERE delivered_at IS NULL
 * RETURNING` is the guard, not the frame delivery itself, so what matters
 * here is that the claim only ever succeeds once and that a release
 * genuinely reopens the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReturning, mockSet, mockWhere, mockUpdate } = vi.hoisted(() => {
  const mockReturning = vi.fn().mockResolvedValue([{ id: 'ntf_abc123' }]);
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  return { mockReturning, mockSet, mockWhere, mockUpdate };
});

vi.mock('@/src/db', () => ({
  db: { update: mockUpdate },
  notifications: { id: 'id', deliveredAt: 'delivered_at' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

import { claimNotificationForDelivery, releaseNotificationClaim } from '../delivery';

const ID = 'ntf_abc123';

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([{ id: ID }]);
  mockWhere.mockImplementation(() => ({ returning: mockReturning }));
  mockSet.mockImplementation(() => ({ where: mockWhere }));
  mockUpdate.mockImplementation(() => ({ set: mockSet }));
});

describe('claimNotificationForDelivery', () => {
  it('sets delivered_at and reports success when the row was unclaimed', async () => {
    const claimed = await claimNotificationForDelivery(ID);

    expect(claimed).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ deliveredAt: expect.any(Date) }));
    expect(mockWhere).toHaveBeenCalledWith({
      and: [{ eq: ['id', ID] }, { isNull: ['delivered_at'] }],
    });
  });

  it('guards on delivered_at IS NULL, so an already-claimed row reports false', async () => {
    mockReturning.mockResolvedValueOnce([]);

    expect(await claimNotificationForDelivery(ID)).toBe(false);
  });
});

describe('releaseNotificationClaim', () => {
  it('nulls delivered_at back out, reopening the row for a future claim', async () => {
    await releaseNotificationClaim(ID);

    expect(mockSet).toHaveBeenCalledWith({ deliveredAt: null });
    expect(mockWhere).toHaveBeenCalledWith({ eq: ['id', ID] });
  });
});
