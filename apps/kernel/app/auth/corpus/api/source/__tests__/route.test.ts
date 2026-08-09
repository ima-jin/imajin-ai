import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockDeleteCorpusSource } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockDeleteCorpusSource: vi.fn(),
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
  deleteCorpusSource: mockDeleteCorpusSource,
}));

import { DELETE } from '../route';
import { CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const DID = 'did:imajin:alice';

type RouteRequest = Parameters<typeof DELETE>[0];

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

describe('DELETE /auth/corpus/api/source', () => {
  it('removes the source for the acting DID', async () => {
    mockDeleteCorpusSource.mockResolvedValue({ deleted: 3 });

    const res = await DELETE(makeReq({ source: 'github:ima-jin/imajin-ai' }));

    expect(mockDeleteCorpusSource).toHaveBeenCalledWith(DID, { source: 'github:ima-jin/imajin-ai' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3 });
  });

  it('returns 401 without deleting when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await DELETE(makeReq({ source: 'github:x/y' }));

    expect(res.status).toBe(401);
    expect(mockDeleteCorpusSource).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await DELETE(makeReq(undefined, { invalidJson: true }));

    expect(res.status).toBe(400);
    expect(mockDeleteCorpusSource).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { source: '' }],
    ['non-string', { source: 42 }],
  ])('returns 400 when source is %s', async (_label, body) => {
    const res = await DELETE(makeReq(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'source is required' });
    expect(mockDeleteCorpusSource).not.toHaveBeenCalled();
  });

  it('maps a corpus service error to its own status', async () => {
    mockDeleteCorpusSource.mockRejectedValueOnce(new CorpusServiceError(400, 'source is required'));

    const res = await DELETE(makeReq({ source: 'github:x/y' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'source is required' });
  });

  it('returns 502 without leaking the underlying failure for unexpected errors', async () => {
    mockDeleteCorpusSource.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await DELETE(makeReq({ source: 'github:x/y' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to remove corpus source' });
  });
});
