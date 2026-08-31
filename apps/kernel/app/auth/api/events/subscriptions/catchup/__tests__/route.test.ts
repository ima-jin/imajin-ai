/**
 * Tests for GET /auth/api/events/subscriptions/catchup (#1884).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, catchUpMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  catchUpMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/src/lib/auth/event-subscriptions', () => ({ catchUpSubscriptionEvents: catchUpMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET } from '../route';

const AGENT = 'did:imajin:matchmaker-agent';

function makeRequest(query = ''): Request {
  return new Request(`http://localhost:3000/auth/api/events/subscriptions/catchup${query}`, {
    headers: { cookie: 'imajin_session=test-token' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authentication', () => {
  it('rejects an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(401);
    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('resolves the caller DID from the authenticated identity', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: AGENT } });
    catchUpMock.mockResolvedValue({ events: [], nextCursor: '0', entitledEventTypes: [] });

    await GET(makeRequest() as never);

    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ agentDid: AGENT }));
  });
});

describe('request validation', () => {
  beforeEach(() => {
    requireAuthMock.mockResolvedValue({ identity: { id: AGENT } });
    catchUpMock.mockResolvedValue({ events: [], nextCursor: '0', entitledEventTypes: [] });
  });

  it('defaults cursor to 0 when omitted', async () => {
    await GET(makeRequest() as never);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ cursor: BigInt(0) }));
  });

  it('parses a numeric cursor', async () => {
    await GET(makeRequest('?cursor=42') as never);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ cursor: BigInt(42) }));
  });

  it('rejects a non-numeric cursor with 400', async () => {
    const res = await GET(makeRequest('?cursor=not-a-number') as never);
    expect(res.status).toBe(400);
    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('rejects a negative cursor with 400', async () => {
    const res = await GET(makeRequest('?cursor=-1') as never);
    expect(res.status).toBe(400);
    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative limit with 400', async () => {
    const res = await GET(makeRequest('?limit=0') as never);
    expect(res.status).toBe(400);
    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('passes a valid limit through', async () => {
    await GET(makeRequest('?limit=50') as never);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });
});

describe('resolution', () => {
  it('returns the catch-up result on success', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: AGENT } });
    const result = {
      events: [{ id: 'evt_1', cursor: '1', eventType: 'availability.match.surfaced' }],
      nextCursor: '1',
      entitledEventTypes: ['availability.match.surfaced'],
    };
    catchUpMock.mockResolvedValue(result);

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it('returns 500 when the lookup throws', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: AGENT } });
    catchUpMock.mockRejectedValue(new Error('db unreachable'));

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(500);
  });
});
