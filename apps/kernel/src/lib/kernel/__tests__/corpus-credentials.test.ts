import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCredential, claim, resolveOwner, authorizeOwner } = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  resolveOwner: vi.fn(async (_source: string, did: string) => did),
  authorizeOwner: vi.fn(async () => true),
  claim: vi.fn(async () => 'signed-claim-fixture'),
}));
vi.mock('../corpus-access-claim', () => ({ corpusAccessClaimHeader: claim }));
vi.mock('../../github/corpus-credential', () => ({ resolveCorpusGitHubCredential: resolveCredential }));
vi.mock('../corpus-owner', () => ({ resolveCorpusDid: resolveOwner, authorizeCorpusOwner: authorizeOwner }));
import { corpusHttpRequest } from '../corpus-http';

const did = 'did:imajin:corpus-owner';
const source = 'github:ima-jin/imajin-ai';
let token: string;
let fetchMock: ReturnType<typeof vi.fn>;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
/** Assertion diagnostics may show a digest, never credential bytes. */
function credentialDigest(value: string | undefined): string {
  return createHash('sha256').update(value ?? '').digest('hex');
}
beforeEach(() => {
  vi.clearAllMocks();
  resolveOwner.mockImplementation(async (_source: string, did: string) => did);
  authorizeOwner.mockResolvedValue(true);
  token = randomUUID();
  resolveCredential.mockResolvedValue(token);
  fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/status')
    ? json({ sources: [{ source, credentialRef: 'github:work' }] })
    : json({ ingested: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('corpus GitHub credential transport', () => {
  it('uses the group connector and persisted ref, never a caller personal connector or body owner', async () => {
    const group = 'did:imajin:group';
    resolveOwner.mockResolvedValue(group);
    fetchMock.mockImplementation(async url => url.endsWith('/status')
      ? json({ sources: [{ source, credentialRef: url.includes(encodeURIComponent(group)) ? 'github:org' : 'github:personal' }] })
      : json({ ingested: 0 }));
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source, credentialRef: 'github:personal', ownerDid: did });
    expect(resolveCredential).toHaveBeenCalledWith(group, source, 'github:org');
    expect(fetchMock.mock.calls.every(([url]) => url.includes(encodeURIComponent(group)))).toBe(true);
    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers['X-Corpus-Credential-Ref']).toBe('github:org');
    expect(credentialDigest(headers['X-Corpus-GitHub-Credential'])).toBe(credentialDigest(token));
    expect(claim).toHaveBeenCalledWith(group, 'corpus:write', did);
  });
  it('does not fall back to the caller connector when the group connector is unavailable', async () => {
    const group = 'did:imajin:group';
    resolveOwner.mockResolvedValue(group);
    resolveCredential.mockImplementation(async owner => {
      if (owner === group) throw new Error('group connector missing');
      return token;
    });
    await corpusHttpRequest('POST', did, 'corpus:write', '/ingest', { source, credentialRef: 'github:personal' });
    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(resolveCredential).toHaveBeenCalledWith(group, source, 'github:personal');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Corpus-GitHub-Credential']).toBeUndefined();
    expect(headers['X-Corpus-Credential-Ref']).toBeUndefined();
  });
  it('returns 403 before any credential lookup or transport when the group grant is revoked', async () => {
    resolveOwner.mockResolvedValue('did:imajin:group');
    authorizeOwner.mockResolvedValue(false);
    const result = await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source, credentialRef: 'github:personal' });
    expect(result.status).toBe(403);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
  it('refuses a workspace write into a granted group target before sending anything', async () => {
    const result = await corpusHttpRequest('POST', did, 'corpus:write', '/ingest',
      [{ source: 'local:workspace' }], 'did:imajin:group');
    expect(result.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveCredential).not.toHaveBeenCalled();
  });
  it('replaces transport exceptions before they can be logged by dashboard routes', async () => {
    fetchMock.mockRejectedValueOnce(new Error(token));
    await expect(corpusHttpRequest('POST', did, 'corpus:write', '/ingest', { source, credentialRef: 'github:work' }))
      .rejects.toThrow('Corpus service transport failed');
  });
  it('resolves the selected connector for the effective owner, not a client-supplied DID', async () => {
    await corpusHttpRequest('POST', did, 'corpus:write', '/ingest', { source, credentialRef: 'github:work', ownerDid: 'did:imajin:other' });
    expect(resolveCredential).toHaveBeenCalledWith(did, source, 'github:work');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(credentialDigest((init.headers as Record<string, string>)['X-Corpus-GitHub-Credential'])).toBe(credentialDigest(token));
    expect(String(init.body).includes(token)).toBe(false);
  });

  it('re-resolves on each sync, uses persisted ref, and forwards no credential after revoke', async () => {
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source, credentialRef: 'github:attacker' });
    resolveCredential.mockRejectedValueOnce(new Error(token));
    await corpusHttpRequest('POST', did, 'corpus:write', '/sync', { source });
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(resolveCredential).toHaveBeenNthCalledWith(1, did, source, 'github:work');
    const writes = fetchMock.mock.calls.filter(([url]) => url.endsWith('/sync'));
    expect(credentialDigest((writes[0][1].headers as Record<string, string>)['X-Corpus-GitHub-Credential'])).toBe(credentialDigest(token));
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
