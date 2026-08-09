import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockSyncCorpusSource } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockSyncCorpusSource: vi.fn(),
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
  syncCorpusSource: mockSyncCorpusSource,
}));

import { POST } from '../route';
import { CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const DID = 'did:imajin:alice';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(body?: unknown, opts: { invalidJson?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.invalidJson) throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: DID } });
});

describe('POST /auth/corpus/api/sync', () => {
  it('proxies a single-source sync to the corpus service', async () => {
    mockSyncCorpusSource.mockResolvedValue({ synced: true });

    const res = await POST(makeReq({ source: 'github:ima-jin/imajin-ai' }));

    expect(mockSyncCorpusSource).toHaveBeenCalledWith(DID, { source: 'github:ima-jin/imajin-ai' });
    expect(res.status).toBe(200);
  });

  it('syncs every source when no body is given', async () => {
    mockSyncCorpusSource.mockResolvedValue({ synced: true });

    await POST(makeReq(undefined, { invalidJson: true }));

    expect(mockSyncCorpusSource).toHaveBeenCalledWith(DID, {});
  });

  it('returns 401 without syncing when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq({ source: 'github:x/y' }));

    expect(res.status).toBe(401);
    expect(mockSyncCorpusSource).not.toHaveBeenCalled();
  });

  it('maps a corpus service error to its own status', async () => {
    mockSyncCorpusSource.mockRejectedValueOnce(new CorpusServiceError(501, 'sync is not implemented in v1'));

    const res = await POST(makeReq({ source: 'github:x/y' }));

    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'sync is not implemented in v1' });
  });

  it('returns 502 without leaking the underlying failure for unexpected errors', async () => {
    mockSyncCorpusSource.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(makeReq({ source: 'github:x/y' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to sync corpus source' });
  });
});
