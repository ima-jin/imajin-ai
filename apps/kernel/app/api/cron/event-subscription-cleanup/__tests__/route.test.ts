/**
 * Unit tests for GET /api/cron/event-subscription-cleanup (#1884).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReturning, mockDelete } = vi.hoisted(() => {
  const mockReturning = vi.fn<() => Promise<Array<{ id: string }>>>();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  return { mockReturning, mockDelete };
});

vi.mock('@/src/db', () => ({
  db: { delete: mockDelete },
  eventSubscriptionLog: {},
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({ EVENT_SUBSCRIPTION_RETENTION: 14 * 24 * 60 * 60 * 1000 }));

import { GET } from '../route';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/event-subscription-cleanup', { headers });
}

describe('GET /api/cron/event-subscription-cleanup', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('passes auth when CRON_SECRET matches Bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    expect(response.status).toBe(200);
  });

  it('passes auth (dev mode) when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(200);
  });

  it('deletes rows older than the retention window and reports the count', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; deleted: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, deleted: 2 });
    expect(mockDelete).toHaveBeenCalledOnce();
  });

  it('no-op: returns deleted=0 when nothing is past retention', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; deleted: number };
    expect(body).toEqual({ ok: true, deleted: 0 });
  });

  it('returns 500 when the DB delete throws', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
  });
});
