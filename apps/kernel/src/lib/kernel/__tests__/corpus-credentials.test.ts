import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCredential, claim } = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  claim: vi.fn(async () => 'signed-claim-fixture'),
}));
vi.mock('../corpus-access-claim', () => ({ corpusAccessClaimHeader: claim }));
vi.mock('../../github/corpus-credential', () => ({ resolveCorpusGitHubCredential: resolveCredential }));
import { corpusHttpRequest } from '../corpus-http';

const did = 'did:imajin:corpus-owner';
const source = 'github:ima-jin/imajin-ai';
let token: string;
let fetchMock: ReturnType<typeof vi.fn>;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
beforeEach(() => {
  vi.clearAllMocks();
  token = randomUUID();
  resolveCredential.mockResolvedValue(token);
  fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/status')
    ? json({ sources: [{ source, credentialRef: 'github:work' }] })
    : json({ ingested: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('corpus GitHub credential transport', () => {
  it('replaces transport exceptions before they can be logged by dashboard routes', async () => {
    fetchMock.mockRejectedValueOnce(new Error(token));
    await expect(corpusHttpRequest('POST', did, 'corpus:write', '/ingest', { source, credentialRef: 'github:work' }))
      .rejects.toThrow('Corpus service transport failed');
  });
  it('resolves the selected connector for the effective owner, not a client-supplied DID', async () => {
    await corpusHttpRequest('POST', did, 'corpus:write', '/ingest', { source, credentialRef: 'github:work', ownerDid: 'did:imajin:other' });
    expect(resolveCredential).toHaveBeenCalledWith(did, source, 'github:work');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Corpus-GitHub-Credential'] === token).toBe(true);
    expect(String(init.body).includes(token)).toBe(false);
  });

  it('re-resolves on each sync, uses persisted ref, and forwards no credential after revoke', async () => {
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source, credentialRef: 'github:attacker' });
    resolveCredential.mockRejectedValueOnce(new Error(token));
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source });
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(resolveCredential).toHaveBeenNthCalledWith(1, did, source, 'github:work');
    const writes = fetchMock.mock.calls.filter(([url]) => url.endsWith('/sync'));
    expect((writes[0][1].headers as Record<string, string>)['X-Corpus-GitHub-Credential'] === token).toBe(true);
    expect((writes[1][1].headers as Record<string, string>)['X-Corpus-GitHub-Credential']).toBeUndefined();
  });

  it.each([{ sources: [] }, { sources: [{ source }] }, { sources: {} }])('fails closed when no persisted ref exists: %j', async ({ sources }) => {
    fetchMock.mockResolvedValueOnce(json({ sources }));
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls).includes(token)).toBe(false);
  });

  it('does not resolve a credential for read scopes or non-GitHub requests', async () => {
    await corpusHttpRequest('POST', did, 'corpus:read', '/search', { source, credentialRef: 'github:work' });
    await corpusHttpRequest('POST', did, 'corpus:write', '/ingest', { source: 'local:workspace' });
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('does not resolve credentials when the stored source status is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'unavailable' }, 503));
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source });
    expect(resolveCredential).not.toHaveBeenCalled();
  });
});
