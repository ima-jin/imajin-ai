import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockFetchCorpusStatus } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFetchCorpusStatus: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/corpus-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/kernel/corpus-client')>()),
  fetchCorpusStatus: mockFetchCorpusStatus,
}));

import { GET } from '../route';
import { CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const DID = 'did:imajin:alice';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: DID } });
});

describe('GET /auth/corpus/api/status', () => {
  it('returns the acting DID corpus status', async () => {
    mockFetchCorpusStatus.mockResolvedValue({
      sources: [{ source: 'github:ima-jin/imajin-ai', lastSync: '2026-08-09T00:00:00.000Z', threadCount: 12 }],
      threadCount: 12,
    });

    const res = await GET(makeReq());

    expect(mockFetchCorpusStatus).toHaveBeenCalledWith(DID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sources: [{ source: 'github:ima-jin/imajin-ai', lastSync: '2026-08-09T00:00:00.000Z', threadCount: 12 }],
      threadCount: 12,
    });
  });

  it('resolves against the acting-for DID, not the raw session DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: DID, actingFor: 'did:imajin:business' } });
    mockFetchCorpusStatus.mockResolvedValue({ sources: [], threadCount: 0 });

    await GET(makeReq());

    expect(mockFetchCorpusStatus).toHaveBeenCalledWith('did:imajin:business');
  });

  it('returns 401 without querying the corpus service when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(mockFetchCorpusStatus).not.toHaveBeenCalled();
  });

  it('maps a corpus service error to its own status', async () => {
    mockFetchCorpusStatus.mockRejectedValueOnce(new CorpusServiceError(404, 'did not found'));

    const res = await GET(makeReq());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'did not found' });
  });

  it('returns 502 without leaking the underlying failure for unexpected errors', async () => {
    mockFetchCorpusStatus.mockRejectedValueOnce(new Error('connection reset'));

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Corpus status unavailable' });
  });

  it('marks the response as no-store', async () => {
    mockFetchCorpusStatus.mockResolvedValue({ sources: [], threadCount: 0 });

    const res = await GET(makeReq());

    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
