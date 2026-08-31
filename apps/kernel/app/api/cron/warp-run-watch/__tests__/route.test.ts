/**
 * Unit tests for GET /api/cron/warp-run-watch (#1838).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSweep } = vi.hoisted(() => ({
  mockSweep: vi.fn(),
}));

vi.mock('@/src/lib/warp/run-watch-sweep', () => ({
  sweepInFlightWarpRuns: mockSweep,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GET } from '../route';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/warp-run-watch', { headers });
}

const EMPTY_OUTCOME = { checked: 0, completed: 0, failed: 0, blockedNotified: 0, stillInFlight: 0, errors: 0 };

describe('GET /api/cron/warp-run-watch', () => {
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
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches Bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    expect(response.status).toBe(200);
  });

  it('passes auth (dev mode) when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(200);
  });

  it('runs the sweep and reports its outcome', async () => {
    delete process.env.CRON_SECRET;
    mockSweep.mockResolvedValue({
      checked: 3,
      completed: 1,
      failed: 0,
      blockedNotified: 1,
      stillInFlight: 1,
      errors: 0,
    });

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { ok: boolean; checked: number; blockedNotified: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      checked: 3,
      completed: 1,
      failed: 0,
      blockedNotified: 1,
      stillInFlight: 1,
      errors: 0,
    });
    expect(mockSweep).toHaveBeenCalledOnce();
  });

  it('returns 500 when the sweep throws', async () => {
    delete process.env.CRON_SECRET;
    mockSweep.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
