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
import { _setCronSecretForTests, _resetCronSecretForTests } from '@/src/cron/secret';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/warp-run-watch', { headers });
}

const EMPTY_OUTCOME = { checked: 0, completed: 0, failed: 0, blockedNotified: 0, stillInFlight: 0, errors: 0 };

const CRON_AUTH = { authorization: 'Bearer test-secret' };

describe('GET /api/cron/warp-run-watch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetCronSecretForTests();
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    _setCronSecretForTests('test-secret');
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    _setCronSecretForTests('test-secret');
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches Bearer token', async () => {
    _setCronSecretForTests('test-secret');
    mockSweep.mockResolvedValue(EMPTY_OUTCOME);

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    expect(response.status).toBe(200);
  });

  it('fails closed with 503 when CRON_SECRET is not set (#2550)', async () => {
    _setCronSecretForTests(null);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(503);
  });

  it('runs the sweep and reports its outcome', async () => {
    _setCronSecretForTests('test-secret');
    mockSweep.mockResolvedValue({
      checked: 3,
      completed: 1,
      failed: 0,
      blockedNotified: 1,
      stillInFlight: 1,
      errors: 0,
    });

    const response = await GET(makeRequest(CRON_AUTH) as never);
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
    _setCronSecretForTests('test-secret');
    mockSweep.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest(CRON_AUTH) as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
