import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockListActiveGrantOwners, mockResolveAppDidForOwner, mockSettlePaidInvoices } = vi.hoisted(() => ({
  mockListActiveGrantOwners: vi.fn(),
  mockResolveAppDidForOwner: vi.fn(),
  mockSettlePaidInvoices: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/quickbooks/connector', () => ({ listActiveGrantOwners: mockListActiveGrantOwners }));
vi.mock('@/src/lib/quickbooks/realm-index', () => ({ resolveAppDidForOwner: mockResolveAppDidForOwner }));
vi.mock('@/src/lib/quickbooks/settlement', () => ({ settlePaidInvoices: mockSettlePaidInvoices }));

import { GET } from '../route.js';

const SCOTT = 'did:imajin:scott';
const DAVID = 'did:imajin:david-farms';
const APP = 'did:imajin:agrifortress';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/quickbooks-reconcile', { headers });
}

describe('GET /api/cron/quickbooks-reconcile (xprize #35)', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAppDidForOwner.mockResolvedValue(APP);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockListActiveGrantOwners.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockListActiveGrantOwners.mockResolvedValue([]);

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('passes auth (dev mode) when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(200);
  });

  // ── Sweep logic ───────────────────────────────────────────────────────────

  it('settles every owner with an active quickbooks:read grant', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([SCOTT, DAVID]);
    mockSettlePaidInvoices
      .mockResolvedValueOnce({ settled: ['inv1'], skipped: [] })
      .mockResolvedValueOnce({ settled: [], skipped: ['inv2'] });

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; owners: number; settled: number; results: unknown[] };

    expect(response.status).toBe(200);
    expect(mockListActiveGrantOwners).toHaveBeenCalledWith('quickbooks:read');
    expect(mockSettlePaidInvoices).toHaveBeenCalledWith(SCOTT, APP);
    expect(mockSettlePaidInvoices).toHaveBeenCalledWith(DAVID, APP);
    expect(body.ok).toBe(true);
    expect(body.owners).toBe(2);
    expect(body.settled).toBe(1);
    expect(body.results).toHaveLength(2);
  });

  it('no-op: returns owners=0 when no active grants exist', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; owners: number; settled: number };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.owners).toBe(0);
    expect(body.settled).toBe(0);
    expect(mockSettlePaidInvoices).not.toHaveBeenCalled();
  });

  it('collects a per-owner failure without aborting the rest of the sweep', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([SCOTT, DAVID]);
    mockSettlePaidInvoices
      .mockRejectedValueOnce(new Error('quickbooks_no_tokens'))
      .mockResolvedValueOnce({ settled: ['inv2'], skipped: [] });

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { owners: number; settled: number; failures: Array<{ ownerDid: string }> };

    expect(response.status).toBe(200);
    expect(body.owners).toBe(2);
    expect(body.settled).toBe(1);
    expect(body.failures).toEqual([{ ownerDid: SCOTT, error: 'Error: quickbooks_no_tokens' }]);
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns 500 when enumerating owners throws', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
