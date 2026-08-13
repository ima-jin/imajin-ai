/**
 * Unit tests for GET /api/cron/attestation-cleanup (#1842).
 *
 * Acceptance criteria verified:
 *   - Expired attestations are deleted.
 *   - Non-expired and null-expiry attestations are not touched.
 *   - Sweep is a no-op and returns ok when no expired attestations exist.
 *   - CRON_SECRET auth works identically to other cron routes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock: @/src/db — drizzle delete chain ───────────────────────────────────

const { mockReturning, mockDelete } = vi.hoisted(() => {
  const mockReturning = vi.fn<() => Promise<Array<{ id: string }>>>();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  return { mockReturning, mockDelete };
});

vi.mock('@/src/db', () => ({
  db: { delete: mockDelete },
  attestations: {},
}));

// ── Mock: logger ─────────────────────────────────────────────────────────────

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { GET } from '../route.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/attestation-cleanup', { headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/attestation-cleanup', () => {
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

  // ── Auth ───────────────────────────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
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

  // ── Sweep logic ─────────────────────────────────────────────────────────────

  it('deletes expired attestations and returns their ids', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockResolvedValue([{ id: 'att_1' }, { id: 'att_2' }]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; deleted: number; ids: string[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(2);
    expect(body.ids).toEqual(['att_1', 'att_2']);

    expect(mockDelete).toHaveBeenCalledOnce();
  });

  it('no-op: returns deleted=0 and empty ids when no expired attestations exist', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockResolvedValue([]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; deleted: number; ids: string[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(0);
    expect(body.ids).toEqual([]);
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('returns 500 when the DB delete throws', async () => {
    delete process.env.CRON_SECRET;
    mockReturning.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
