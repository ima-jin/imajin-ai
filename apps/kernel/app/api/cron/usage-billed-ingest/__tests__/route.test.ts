import { describe, it, expect, vi } from 'vitest';
import { describeCronSecretAuthContract } from '@/src/lib/kernel/__tests__/cron-route-contract';

const { mockRunBilledUsageIngestion } = vi.hoisted(() => ({
  mockRunBilledUsageIngestion: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/usage/billed/ingest-job', () => ({ runBilledUsageIngestion: mockRunBilledUsageIngestion }));

import { GET } from '../route.js';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/usage-billed-ingest', { headers });
}

describe('GET /api/cron/usage-billed-ingest (#1076 Stage 1)', () => {
  describeCronSecretAuthContract({
    makeRequest,
    callRoute: (request) => GET(request as never),
  });

  it('runs the sweep and returns its result when auth passes', async () => {
    delete process.env.CRON_SECRET;
    mockRunBilledUsageIngestion.mockResolvedValue({ owners: 2, results: [{ provider: 'anthropic' }], failures: [] });

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; owners: number };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.owners).toBe(2);
    expect(mockRunBilledUsageIngestion).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the sweep throws', async () => {
    delete process.env.CRON_SECRET;
    mockRunBilledUsageIngestion.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
