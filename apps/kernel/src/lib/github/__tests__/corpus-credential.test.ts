import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { grant, loadToken, readAllowlist, allowed, rows, where } = vi.hoisted(() => ({
  grant: vi.fn(), loadToken: vi.fn(), readAllowlist: vi.fn(), allowed: vi.fn(),
  rows: vi.fn(), where: vi.fn(),
}));
vi.mock('../connector', () => ({
  GITHUB_CONNECTOR_DID: 'did:imajin:github-connector',
  resolveActiveGrant: grant, loadCorpusAccessToken: loadToken,
}));
vi.mock('../allowlist', () => ({ readReadAllowlist: readAllowlist, isRepoAllowed: allowed }));
vi.mock('../../kernel/connector-registry-store', () => ({ readConnectorRegistration: vi.fn() }));
vi.mock('@/src/db', () => ({
  channelLinks: { did: 'did', appDid: 'appDid', channel: 'channel', status: 'status', slot: 'slot', scopes: 'scopes' },
  db: { select: () => ({ from: () => ({ where: rows }) }) },
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args, and: (...args: unknown[]) => { where(...args); return args; } }));

import { corpusConnectorSlot, listCorpusGitHubConnectors, resolveCorpusGitHubCredential } from '../corpus-credential';
import { currentConnectionSlot } from '../../kernel/connector-connection-context';
import { readConnectorRegistration } from '../../kernel/connector-registry-store';
const did = 'did:imajin:owner';
const source = 'github:ima-jin/imajin-ai';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readConnectorRegistration).mockResolvedValue(undefined);
  grant.mockResolvedValue(true);
  loadToken.mockImplementation(async () => {
    expect(currentConnectionSlot('github', did)).toBe('work');
    return randomUUID();
  });
  readAllowlist.mockResolvedValue(null);
  allowed.mockReturnValue(true);
});

describe('corpus GitHub OAuth/vault resolution', () => {
  it('fails closed with connection removed before reading any token or trying another slot', async () => {
    vi.mocked(readConnectorRegistration).mockResolvedValue({ status: 'removed' } as never);
    await expect(resolveCorpusGitHubCredential(did, source, 'github:work')).rejects.toThrow('Connection removed');
    expect(readConnectorRegistration).toHaveBeenCalledWith(did, 'github', 'work');
    expect(grant).not.toHaveBeenCalled();
    expect(loadToken).not.toHaveBeenCalled();
  });
  it('resolves the live slot-bound OAuth grant and vault credential on every invocation', async () => {
    await resolveCorpusGitHubCredential(did, source, 'github:work');
    await resolveCorpusGitHubCredential(did, source, 'github:work');
    expect(grant).toHaveBeenCalledWith(did, 'github:read', 'work');
    expect(loadToken).toHaveBeenCalledTimes(2);
    expect(loadToken).toHaveBeenCalledWith(did, undefined, 'work');
    expect(allowed).toHaveBeenCalledWith('ima-jin/imajin-ai', null);
  });
  it('fails after revocation before touching vault material', async () => {
    grant.mockResolvedValue(false);
    await expect(resolveCorpusGitHubCredential(did, source, 'github:work')).rejects.toThrow(/revoked/);
    expect(loadToken).not.toHaveBeenCalled();
  });
  it('denies an out-of-allowlist repo before touching vault material', async () => {
    allowed.mockReturnValue(false);
    await expect(resolveCorpusGitHubCredential(did, source, 'github:work')).rejects.toThrow(/allowlist/);
    expect(loadToken).not.toHaveBeenCalled();
  });
  it('has no PAT fallback when OAuth is missing', async () => {
    loadToken.mockResolvedValue(undefined);
    await expect(resolveCorpusGitHubCredential(did, source, 'github:work')).rejects.toThrow(/no active OAuth/);
  });
  it.each([undefined, null, '', 'github:UPPER', 'github:a/b', 'github:other:owner', 'vault:field', {}])('rejects invalid refs: %j', ref => {
    expect(() => corpusConnectorSlot(ref)).toThrow(/Select a GitHub connector/);
  });
  it('lists only read-capable slots from the authenticated owner query with no secrets', async () => {
    rows.mockResolvedValue([
      { slot: 'work', scopes: ['github:read'] }, { slot: 'work', scopes: ['github:read'] },
      { slot: 'write-only', scopes: ['github:write'] }, { slot: 'invalid', scopes: {} },
    ]);
    expect(await listCorpusGitHubConnectors(did)).toEqual([{ ref: 'github:work', label: 'GitHub · work' }]);
    expect(where).toHaveBeenCalledWith(['did', did], ['appDid', 'did:imajin:github-connector'], ['channel', 'github'], ['status', 'active']);
  });
});
