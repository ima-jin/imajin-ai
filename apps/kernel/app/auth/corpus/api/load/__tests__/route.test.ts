import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockLoadCorpusSource } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockLoadCorpusSource: vi.fn(),
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
  loadCorpusSource: mockLoadCorpusSource,
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

describe('POST /auth/corpus/api/load', () => {
  it('proxies the submitted body to the corpus service for the acting DID', async () => {
    mockLoadCorpusSource.mockResolvedValue({ ingested: 0 });

    const res = await POST(makeReq({ sourceType: 'github', source: 'github:ima-jin/imajin-ai' }));

    expect(mockLoadCorpusSource).toHaveBeenCalledWith(DID, {
      sourceType: 'github',
      source: 'github:ima-jin/imajin-ai',
    });
    expect(res.status).toBe(201);
  });

  it('loads under the acting-for DID, not the raw session DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: DID, actingFor: 'did:imajin:business' } });
    mockLoadCorpusSource.mockResolvedValue({ ingested: 0 });

    await POST(makeReq({ sourceType: 'local', source: 'local:/tmp/notes' }));

    expect(mockLoadCorpusSource).toHaveBeenCalledWith('did:imajin:business', {
      sourceType: 'local',
      source: 'local:/tmp/notes',
    });
  });

  it('returns 401 without loading when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeReq({ sourceType: 'github', source: 'github:x/y' }));

    expect(res.status).toBe(401);
    expect(mockLoadCorpusSource).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq(undefined, { invalidJson: true }));

    expect(res.status).toBe(400);
    expect(mockLoadCorpusSource).not.toHaveBeenCalled();
  });

  it('maps a corpus service error to its own status', async () => {
    mockLoadCorpusSource.mockRejectedValueOnce(new CorpusServiceError(400, 'body must be a ThreadDocument[]'));

    const res = await POST(makeReq({ sourceType: 'github', source: 'github:x/y' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body must be a ThreadDocument[]' });
  });

  it('returns 502 without leaking the underlying failure for unexpected errors', async () => {
    mockLoadCorpusSource.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(makeReq({ sourceType: 'github', source: 'github:x/y' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to load corpus source' });
  });
});
