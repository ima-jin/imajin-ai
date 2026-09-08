/**
 * Tests for `getNotificationBacklog` (#2044, #2099) — the backlog replay
 * `ws-server.js` triggers immediately after a DID reconnects.
 *
 * What matters here: only un-acked + unread rows are candidates, oldest
 * first; each candidate is claimed for a WS-send *attempt* one at a time so
 * a row a concurrent live push already claimed, one still within its ack
 * grace period, or one that has exhausted its re-offer cap (#2099) is
 * skipped rather than replayed twice or forever; the result reports
 * truncation without needing a separate COUNT query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLimit, mockClaim, logMock } = vi.hoisted(() => ({
  mockLimit: vi.fn().mockResolvedValue([]),
  mockClaim: vi.fn().mockResolvedValue({ claimed: true, attempts: 1 }),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/db', () => {
  // Broken into sibling named helpers, rather than one arrow nested inside
  // another, to keep .select().from().where().orderBy().limit(...) shallow
  // (sonarjs/no-nested-functions).
  const limitChain = () => ({ limit: mockLimit });
  const orderByChain = () => ({ orderBy: limitChain });
  const whereChain = () => ({ where: orderByChain });
  const fromChain = () => ({ from: whereChain });
  return {
    db: { select: vi.fn(fromChain) },
    notifications: {
      id: 'id',
      recipientDid: 'recipient_did',
      deliveredAt: 'delivered_at',
      read: 'read',
      createdAt: 'created_at',
    },
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  asc: (...args: unknown[]) => ({ asc: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('../delivery', () => ({
  claimNotificationForWsSend: mockClaim,
  WS_MAX_ATTEMPTS: 3,
}));

import { getNotificationBacklog, BACKLOG_LIMIT } from '../backlog';

const RECIPIENT = 'did:imajin:veteze';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ntf_1',
    scope: 'warp.run.completed',
    title: 'Warp run completed',
    body: 'Run SUCCEEDED: Nightly',
    data: { runId: '019f9990' },
    createdAt: new Date('2026-08-06T05:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLimit.mockResolvedValue([]);
  mockClaim.mockResolvedValue({ claimed: true, attempts: 1 });
});

describe('getNotificationBacklog', () => {
  it('requests one more row than the cap, to detect truncation without a count query', async () => {
    await getNotificationBacklog(RECIPIENT);

    expect(mockLimit).toHaveBeenCalledWith(BACKLOG_LIMIT + 1);
  });

  it('returns an empty, non-truncated backlog when there is nothing pending', async () => {
    const result = await getNotificationBacklog(RECIPIENT);

    expect(result).toEqual({ frames: [], truncated: false });
  });

  it('builds a replay frame for each claimed row', async () => {
    mockLimit.mockResolvedValueOnce([row()]);

    const { frames, truncated } = await getNotificationBacklog(RECIPIENT);

    expect(truncated).toBe(false);
    expect(frames).toEqual([{
      type: 'notification',
      id: 'ntf_1',
      scope: 'warp.run.completed',
      title: 'Warp run completed',
      body: 'Run SUCCEEDED: Nightly',
      data: { runId: '019f9990' },
      createdAt: '2026-08-06T05:00:00.000Z',
      replay: true,
    }]);
  });

  it('claims every candidate row before building its frame', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' }), row({ id: 'ntf_2' })]);

    await getNotificationBacklog(RECIPIENT);

    expect(mockClaim).toHaveBeenCalledWith('ntf_1');
    expect(mockClaim).toHaveBeenCalledWith('ntf_2');
    expect(mockClaim).toHaveBeenCalledTimes(2);
  });

  it('re-offers a row exactly once per reconnect when its claim succeeds', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' })]);
    mockClaim.mockResolvedValueOnce({ claimed: true, attempts: 2 });

    const { frames } = await getNotificationBacklog(RECIPIENT);

    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('ntf_1');
  });

  it('skips a row a concurrent live push already claimed, rather than delivering it twice', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' }), row({ id: 'ntf_2' })]);
    mockClaim.mockResolvedValueOnce({ claimed: false, attempts: 0 }).mockResolvedValueOnce({ claimed: true, attempts: 1 });

    const { frames } = await getNotificationBacklog(RECIPIENT);

    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('ntf_2');
  });

  it('skips a row still within its ack grace period, without warning', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' })]);
    mockClaim.mockResolvedValueOnce({ claimed: false, attempts: 0 });

    const { frames } = await getNotificationBacklog(RECIPIENT);

    expect(frames).toHaveLength(0);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('stops re-offering once a row has exhausted its attempt cap', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' })]);
    // The claim itself enforces the cap in Postgres (delivery.ts); a capped
    // row simply fails to claim, same as any other ineligible row.
    mockClaim.mockResolvedValueOnce({ claimed: false, attempts: 0 });

    const { frames } = await getNotificationBacklog(RECIPIENT);

    expect(frames).toHaveLength(0);
  });

  it('warns when a claimed row has just spent its last permitted re-offer', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' })]);
    mockClaim.mockResolvedValueOnce({ claimed: true, attempts: 3 });

    await getNotificationBacklog(RECIPIENT);

    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ntf_1', recipientDid: RECIPIENT, attempts: 3 }),
      expect.stringContaining('re-offer cap'),
    );
  });

  it('does not warn about the cap for an ordinary re-offer', async () => {
    mockLimit.mockResolvedValueOnce([row({ id: 'ntf_1' })]);
    mockClaim.mockResolvedValueOnce({ claimed: true, attempts: 1 });

    await getNotificationBacklog(RECIPIENT);

    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('caps at BACKLOG_LIMIT rows and reports truncated when more exist', async () => {
    const rows = Array.from({ length: BACKLOG_LIMIT + 1 }, (_, i) => row({ id: `ntf_${i}` }));
    mockLimit.mockResolvedValueOnce(rows);

    const { frames, truncated } = await getNotificationBacklog(RECIPIENT);

    expect(truncated).toBe(true);
    expect(frames).toHaveLength(BACKLOG_LIMIT);
    expect(mockClaim).toHaveBeenCalledTimes(BACKLOG_LIMIT);
  });

  it('does not report truncation when the result exactly fills the cap', async () => {
    const rows = Array.from({ length: BACKLOG_LIMIT }, (_, i) => row({ id: `ntf_${i}` }));
    mockLimit.mockResolvedValueOnce(rows);

    const { truncated } = await getNotificationBacklog(RECIPIENT);

    expect(truncated).toBe(false);
  });

  it('normalises an absent body/data on a claimed row', async () => {
    mockLimit.mockResolvedValueOnce([row({ body: null, data: null })]);

    const { frames } = await getNotificationBacklog(RECIPIENT);

    expect(frames[0].body).toBeNull();
    expect(frames[0].data).toEqual({});
  });
});
