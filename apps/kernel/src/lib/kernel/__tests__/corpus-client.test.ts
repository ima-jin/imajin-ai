import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';

vi.mock('../node-identity', () => ({
  getNodeDid: vi.fn(async () => 'did:imajin:testnode'),
}));

import { fetchCorpusStatus, loadCorpusSource, syncCorpusSource, deleteCorpusSource } from '../corpus-client';

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
