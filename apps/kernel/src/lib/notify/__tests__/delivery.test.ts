/**
 * Tests for the WS-send claim/rollback/release primitives and the
 * ack-confirmed `delivered_at` guard (#2099).
 *
 * `claimNotificationForWsSend` is the atomic mutual-exclusion primitive a
 * live push (ws-push.ts) and a backlog replay (backlog.ts) both rely on to
 * never attempt the same notification twice at once — an un-acked claim
 * older than `WS_ACK_TIMEOUT_MS`, or one exceeding `WS_MAX_ATTEMPTS`, is
 * what this file pins at the query-shape level, since the actual
 * time/attempt filtering happens in Postgres, not in this mocked db chain.
 * `ackNotificationDelivery` is the only place `deliveredAt` is ever set.
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
  notifications: {
    id: 'id',
    recipientDid: 'recipient_did',
    deliveredAt: 'delivered_at',
    wsSentAt: 'ws_sent_at',
    wsAttempts: 'ws_attempts',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  lt: (...args: unknown[]) => ({ lt: args }),
  or: (...args: unknown[]) => ({ or: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: [...strings], values }),
}));

import {
  claimNotificationForWsSend,
  rollbackWsClaim,
  releaseWsClaimsForDid,
  ackNotificationDelivery,
  WS_MAX_ATTEMPTS,
} from '../delivery';

const ID = 'ntf_abc123';
const DID = 'did:imajin:veteze';

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([{ id: ID }]);
  mockWhere.mockImplementation(() => ({ returning: mockReturning }));
  mockSet.mockImplementation(() => ({ where: mockWhere }));
  mockUpdate.mockImplementation(() => ({ set: mockSet }));
});

describe('claimNotificationForWsSend', () => {
  it('claims the row, recording the send attempt, when eligible', async () => {
    mockReturning.mockResolvedValueOnce([{ wsAttempts: 1 }]);

    const result = await claimNotificationForWsSend(ID);

    expect(result).toEqual({ claimed: true, attempts: 1 });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ wsSentAt: expect.any(Date) }),
    );
    expect(mockWhere).toHaveBeenCalledWith({
      and: [
        { eq: ['id', ID] },
        { isNull: ['delivered_at'] },
        { lt: ['ws_attempts', WS_MAX_ATTEMPTS] },
        { or: [{ isNull: ['ws_sent_at'] }, { lt: ['ws_sent_at', expect.any(Date)] }] },
      ],
    });
    expect(mockReturning).toHaveBeenCalledWith({ wsAttempts: 'ws_attempts' });
  });

  it('never touches deliveredAt while claiming', async () => {
    await claimNotificationForWsSend(ID);

    const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('deliveredAt');
  });

  it('reports not claimed, with zero attempts, when nothing eligible matched', async () => {
    mockReturning.mockResolvedValueOnce([]);

    expect(await claimNotificationForWsSend(ID)).toEqual({ claimed: false, attempts: 0 });
  });
});

describe('rollbackWsClaim', () => {
  it('nulls ws_sent_at and decrements ws_attempts, reopening the row immediately', async () => {
    await rollbackWsClaim(ID);

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ wsSentAt: null }));
    expect(mockWhere).toHaveBeenCalledWith({ eq: ['id', ID] });
  });

  it('does not touch deliveredAt', async () => {
    await rollbackWsClaim(ID);

    const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('deliveredAt');
  });
});

describe('releaseWsClaimsForDid', () => {
  it('nulls ws_sent_at for every un-acked row belonging to the DID', async () => {
    await releaseWsClaimsForDid(DID);

    expect(mockSet).toHaveBeenCalledWith({ wsSentAt: null });
    expect(mockWhere).toHaveBeenCalledWith({
      and: [{ eq: ['recipient_did', DID] }, { isNull: ['delivered_at'] }],
    });
  });

  it('leaves ws_attempts untouched -- a heartbeat release does not refund a re-offer', async () => {
    await releaseWsClaimsForDid(DID);

    const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('wsAttempts');
  });
});

describe('ackNotificationDelivery', () => {
  it('sets delivered_at and reports success for a pending row', async () => {
    const delivered = await ackNotificationDelivery(ID);

    expect(delivered).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ deliveredAt: expect.any(Date) }));
    expect(mockWhere).toHaveBeenCalledWith({
      and: [{ eq: ['id', ID] }, { isNull: ['delivered_at'] }],
    });
  });

  it('is a no-op, not a throw, for an unknown or already-delivered id', async () => {
    mockReturning.mockResolvedValueOnce([]);

    await expect(ackNotificationDelivery(ID)).resolves.toBe(false);
  });
});
