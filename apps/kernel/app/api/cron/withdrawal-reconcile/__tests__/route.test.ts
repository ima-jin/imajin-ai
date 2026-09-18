import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRunReconciliation } = vi.hoisted(() => ({
  mockRunReconciliation: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/pay/reconciliation', () => ({ runReconciliation: mockRunReconciliation }));

import { GET } from '../route.js';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/withdrawal-reconcile', { headers });
}

describe('GET /api/cron/withdrawal-reconcile (#2172)', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockRunReconciliation.mockResolvedValue({ rails: [] });

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
    expect(mockRunReconciliation).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is set and the Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockRunReconciliation.mockResolvedValue({ rails: [] });

    const response = await GET(makeRequest({ authorization: 'Bearer wrong' }) as never);
    expect(response.status).toBe(401);
  });

  it('runs the sweep and returns per-rail results when authorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockRunReconciliation.mockResolvedValue({
      rails: [{ rail: 'stripe', matched: 2, externalWithoutLedger: 1, pendingTimeout: 0, newWatermark: new Date('2026-01-01T00:00:00Z') }],
    });

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    const body = (await response.json()) as { ok: boolean; rails: unknown[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.rails).toHaveLength(1);
  });

  it('passes auth (dev mode) when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    mockRunReconciliation.mockResolvedValue({ rails: [] });

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(200);
  });

  it('returns 500 when the sweep throws', async () => {
    delete process.env.CRON_SECRET;
    mockRunReconciliation.mockRejectedValue(new Error('rail unreachable'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
