import { beforeEach, describe, it, expect, vi } from 'vitest';
import { describeCronSecretAuthContract } from '@/src/lib/kernel/__tests__/cron-route-contract';

const { mockRunBilledUsageIngestion, mockBalances } = vi.hoisted(() => ({
  mockRunBilledUsageIngestion: vi.fn(),
  mockBalances: vi.fn().mockResolvedValue([]),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/usage/billed/ingest-job', () => ({ runBilledUsageIngestion: mockRunBilledUsageIngestion }));
vi.mock('@/src/lib/usage/billed/moonshot-job', () => ({ readMoonshotBillingBalances: mockBalances }));

import { GET } from '../route.js';
import { _setCronSecretForTests } from '@/src/cron/secret';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/usage-billed-ingest', { headers });
}

const CRON_AUTH = { authorization: 'Bearer test-secret' };
beforeEach(() => vi.clearAllMocks());

describe('GET /api/cron/usage-billed-ingest (#1076 Stage 1)', () => {
  describeCronSecretAuthContract({
    makeRequest,
    callRoute: (request) => GET(request as never),
  });

  it('keeps billed ingestion successful when balance observation fails without echoing errors', async () => {
    _setCronSecretForTests('test-secret');
    mockRunBilledUsageIngestion.mockResolvedValue({ owners: 0, results: [], failures: [] });
    mockBalances.mockRejectedValueOnce(new Error('mock-key-in-provider-error'));
    const response = await GET(makeRequest(CRON_AUTH) as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.moonshot).toEqual({ billedMode: 'manual-only', error: 'balance_unavailable' });
    expect(JSON.stringify(body)).not.toContain('mock-key-in-provider-error');
  });

  it('runs the sweep and returns its result when auth passes', async () => {
    _setCronSecretForTests('test-secret');
    mockRunBilledUsageIngestion.mockResolvedValue({ owners: 2, results: [{ provider: 'anthropic' }], failures: [] });

    const response = await GET(makeRequest(CRON_AUTH) as never);
    const body = await response.json() as { ok: boolean; owners: number };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.owners).toBe(2);
    expect(mockRunBilledUsageIngestion).toHaveBeenCalledTimes(1);
    expect(body).toHaveProperty('moonshot', { billedMode: 'manual-only', observations: [] });
  });

  it('returns 500 when the sweep throws', async () => {
    _setCronSecretForTests('test-secret');
    mockRunBilledUsageIngestion.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest(CRON_AUTH) as never);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
