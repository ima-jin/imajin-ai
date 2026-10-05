import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRunUsageRollup, mockPreviousUtcDayWindow } = vi.hoisted(() => ({
  mockRunUsageRollup: vi.fn(),
  mockPreviousUtcDayWindow: vi.fn(),
}));

vi.mock('@/src/lib/usage/rollup', () => ({
  runUsageRollup: mockRunUsageRollup,
  previousUtcDayWindow: mockPreviousUtcDayWindow,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from '../route';
import { _setCronSecretForTests, _resetCronSecretForTests } from '@/src/cron/secret';

const WINDOW_START = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-09-02T00:00:00.000Z');

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/usage-rollup', { headers });
}

const CRON_AUTH = { authorization: 'Bearer test-secret' };

describe('GET /api/cron/usage-rollup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviousUtcDayWindow.mockReturnValue({ windowStart: WINDOW_START, windowEnd: WINDOW_END });
    mockRunUsageRollup.mockResolvedValue([]);
  });

  afterEach(() => {
    _resetCronSecretForTests();
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    _setCronSecretForTests('test-secret');

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
    expect(mockRunUsageRollup).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    _setCronSecretForTests('test-secret');

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches Bearer token', async () => {
    _setCronSecretForTests('test-secret');

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    expect(response.status).toBe(200);
  });

  it('fails closed with 503 when CRON_SECRET is not set (#2550)', async () => {
    _setCronSecretForTests(null);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(503);
  });

  it('runs the rollup over the previous UTC day window and reports published/skipped counts', async () => {
    _setCronSecretForTests('test-secret');
    mockRunUsageRollup.mockResolvedValue([
      { principalDid: 'did:imajin:alice', contextId: 'c1', totalCostEstimateUsd: 2, breakdown: [], skipped: false },
      { principalDid: 'did:imajin:bob', contextId: 'c2', totalCostEstimateUsd: 0.1, breakdown: [], skipped: true },
    ]);

    const response = await GET(makeRequest(CRON_AUTH) as never);
    const body = (await response.json()) as {
      ok: boolean;
      windowStart: string;
      windowEnd: string;
      principals: number;
      published: number;
      skipped: number;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.windowStart).toBe(WINDOW_START.toISOString());
    expect(body.windowEnd).toBe(WINDOW_END.toISOString());
    expect(body.principals).toBe(2);
    expect(body.published).toBe(1);
    expect(body.skipped).toBe(1);
    expect(mockRunUsageRollup).toHaveBeenCalledWith(WINDOW_START, WINDOW_END);
  });

  it('returns 500 when the rollup throws', async () => {
    _setCronSecretForTests('test-secret');
    mockRunUsageRollup.mockRejectedValueOnce(new Error('DB unavailable'));

    const response = await GET(makeRequest(CRON_AUTH) as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
