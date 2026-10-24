import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';

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
