import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
vi.mock('../connector-connection-status', () => ({ assertConnectionNotRemoved: vi.fn() }));
import { assertConnectionNotRemoved } from '../connector-connection-status';
import { ConnectionRemovedError } from '../connection-slots';

vi.mock('../node-identity', () => ({
  getNodeDid: vi.fn(async () => 'did:imajin:testnode'),
}));
vi.mock('../corpus-owner', () => ({
  resolveCorpusDid: vi.fn(async (source: string, did: string) => source.startsWith('github:') ? 'did:imajin:org' : did),
  authorizeCorpusOwner: vi.fn(async () => true),
  grantedCorpusOwners: vi.fn(async () => []),
}));

import { fetchCorpusStatus, loadCorpusSource, syncCorpusSource, deleteCorpusSource, searchCorpus } from '../corpus-client';
import { authorizeCorpusOwner, grantedCorpusOwners, resolveCorpusDid } from '../corpus-owner';

const ORIGINAL_AUTH_PRIVATE_KEY = process.env.AUTH_PRIVATE_KEY;
const ORIGINAL_CORPUS_SERVICE_URL = process.env.CORPUS_SERVICE_URL;
const KEYPAIR = authCrypto.generateKeypair();

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

function decodeClaimHeader(header: string): Record<string, unknown> {
  const [, token] = header.split(' ');
  const separatorIndex = token.lastIndexOf('.');
  const encodedClaim = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  expect(authCrypto.verifySync(signature, encodedClaim, KEYPAIR.publicKey)).toBe(true);
  return JSON.parse(Buffer.from(encodedClaim, 'base64url').toString('utf8'));
}

beforeEach(() => {
  vi.mocked(assertConnectionNotRemoved).mockReset();
  vi.mocked(authorizeCorpusOwner).mockResolvedValue(true);
  vi.mocked(grantedCorpusOwners).mockResolvedValue([]);
  process.env.AUTH_PRIVATE_KEY = KEYPAIR.privateKey;
  delete process.env.CORPUS_SERVICE_URL;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_AUTH_PRIVATE_KEY === undefined) delete process.env.AUTH_PRIVATE_KEY;
  else process.env.AUTH_PRIVATE_KEY = ORIGINAL_AUTH_PRIVATE_KEY;
  if (ORIGINAL_CORPUS_SERVICE_URL === undefined) delete process.env.CORPUS_SERVICE_URL;
  else process.env.CORPUS_SERVICE_URL = ORIGINAL_CORPUS_SERVICE_URL;
});

describe('corpus-client CorpusAccessClaim attachment', () => {
  it('shows connection removed on the bound source while preserving its ref and last success', async () => {
    vi.mocked(assertConnectionNotRemoved).mockRejectedValueOnce(new ConnectionRemovedError());
    fetchMock.mockResolvedValue(jsonResponse(200, { sources: [{
      source: 'github:ima-jin/imajin-ai', credentialRef: 'github:work', lastSync: '2026-10-27', threadCount: 42,
    }], threadCount: 42 }));
    expect(await fetchCorpusStatus('did:imajin:alice')).toMatchObject({ sources: [{
      credentialRef: 'github:work', lastSync: '2026-10-27', threadCount: 42, error: expect.stringContaining('Connection removed'),
    }] });
    expect(assertConnectionNotRemoved).toHaveBeenCalledWith('did:imajin:alice', 'github', 'work');
  });

  it('does not turn a connection status outage into a healthy source', async () => {
    vi.mocked(assertConnectionNotRemoved).mockRejectedValueOnce(new Error('database unavailable'));
    fetchMock.mockResolvedValue(jsonResponse(200, { sources: [{
      source: 'github:ima-jin/imajin-ai', credentialRef: 'github:work', lastSync: '', threadCount: 0,
    }], threadCount: 0 }));
    expect((await fetchCorpusStatus('did:imajin:alice')).sources[0].error).toBe('Connection status unavailable.');
  });
  it('includes granted group documents in unscoped search, never requesting ungranted partitions', async () => {
    vi.mocked(grantedCorpusOwners).mockResolvedValue(['did:imajin:org']);
    const hit = (source: string, id: string, score: number) => ({
      source, id, score, evidence: ['ruling'], title: id, type: 'issue', state: 'open', updated: '2026-10-24',
    });
    fetchMock.mockImplementation(async (url: string) => jsonResponse(200, {
      results: url.includes(encodeURIComponent('did:imajin:org'))
        ? [hit('github:ima-jin/imajin-ai', '3089', 1)]
        : [hit('local:workspace', 'notes', 0.5)],
      totalHits: 1, tokensUsed: 2,
    }));
    const result = await searchCorpus('did:imajin:jin', { query: 'ruling' });
    expect(result.results.map(row => row.id)).toEqual(['3089', 'notes']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url.includes(encodeURIComponent('did:imajin:ungranted')))).toBe(false);
    expect(authorizeCorpusOwner).toHaveBeenCalledWith('did:imajin:jin', 'did:imajin:org', 'corpus:read');
    expect(decodeClaimHeader(fetchMock.mock.calls[1][1].headers.Authorization)).toMatchObject({
      did: 'did:imajin:org', scope: 'corpus:read', onBehalfOf: 'did:imajin:jin',
    });
  });
  it('rechecks each discovered owner and returns no partial results after revocation', async () => {
    vi.mocked(grantedCorpusOwners).mockResolvedValue(['did:imajin:org']);
    vi.mocked(authorizeCorpusOwner).mockImplementation(async (_principal, owner) => owner !== 'did:imajin:org');
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], totalHits: 0, tokensUsed: 0 }));
    await expect(searchCorpus('did:imajin:jin', { query: 'ruling' })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('deduplicates, ranks, and applies global result/evidence limits across partitions', async () => {
    vi.mocked(grantedCorpusOwners).mockResolvedValue(['did:imajin:org']);
    fetchMock.mockResolvedValue(jsonResponse(200, {
      results: [{ source: 'github:ima-jin/imajin-ai', id: '1', score: 1, evidence: ['long ruling evidence'] }],
      totalHits: 1, tokensUsed: 5,
    }));
    const result = await searchCorpus('did:imajin:jin', { query: 'ruling', limit: 1, budget: 1 });
    expect(result.results).toHaveLength(1);
    expect(result.totalHits).toBe(1);
    expect(result.results[0].evidence).toEqual(['long']);
    expect(result.tokensUsed).toBe(1);
  });
  it.each(['did:imajin:jin', 'did:imajin:ryan'])('requires an org-issued read grant for %s, and scopes search to the org', async did => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [] }));
    vi.mocked(authorizeCorpusOwner).mockResolvedValue(false);
    await expect(searchCorpus(did, { query: 'ruling', source: 'github:ima-jin/imajin-ai' })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(authorizeCorpusOwner).mockResolvedValue(true);
    await searchCorpus(did, { query: 'ruling', source: 'github:ima-jin/imajin-ai' });
    expect(authorizeCorpusOwner).toHaveBeenLastCalledWith(did, 'did:imajin:org', 'corpus:read');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(encodeURIComponent('did:imajin:org'));
    expect(decodeClaimHeader(init.headers.Authorization)).toMatchObject({ did: 'did:imajin:org', onBehalfOf: did, scope: 'corpus:read' });
  });
  it('discovers granted corpora and returns the true owner for the dashboard', async () => {
    vi.mocked(grantedCorpusOwners).mockResolvedValue(['did:imajin:org']);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sources: [], threadCount: 0 }))
      .mockResolvedValueOnce(jsonResponse(200, { sources: [{ source: 'github:ima-jin/imajin-ai', threadCount: 42 }], threadCount: 42 }));
    expect(await fetchCorpusStatus('did:imajin:ryan')).toMatchObject({
      threadCount: 42, sources: [{ ownerDid: 'did:imajin:org', source: 'github:ima-jin/imajin-ai' }],
    });
  });
  it('rejects mixed owner batches before sending a claim', async () => {
    await expect(loadCorpusSource('did:imajin:jin', [{ source: 'github:ima-jin/imajin-ai' }, { source: 'local:workspace' }])).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails closed on resolver failure', async () => {
    vi.mocked(resolveCorpusDid).mockRejectedValueOnce(new Error('identity offline'));
    await expect(searchCorpus('did:imajin:jin', { query: 'x', source: 'github:ima-jin/imajin-ai' })).rejects.toThrow('identity offline');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fetchCorpusStatus attaches a corpus:read claim whose sub is the acting DID', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sources: [], threadCount: 0 }));

    await fetchCorpusStatus('did:imajin:alice');

    const [, init] = fetchMock.mock.calls[0];
    const claim = decodeClaimHeader(init.headers.Authorization);
    expect(claim).toMatchObject({ did: 'did:imajin:alice', scope: 'corpus:read', aud: 'corpus', alg: 'Ed25519' });
  });

  it('loadCorpusSource, syncCorpusSource, and deleteCorpusSource attach corpus:write claims', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await loadCorpusSource('did:imajin:alice', { source: 'x' });
    await syncCorpusSource('did:imajin:alice', { source: 'x' });
    await deleteCorpusSource('did:imajin:alice', { source: 'x' });

    for (const call of fetchMock.mock.calls) {
      const claim = decodeClaimHeader(call[1].headers.Authorization);
      expect(claim).toMatchObject({ did: 'did:imajin:alice', scope: 'corpus:write' });
    }
  });
});
