import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  grant: vi.fn(), custody: vi.fn(),
  oauthField: (did: string) => `oauth:${did}`, field: (did: string) => `credential:${did}`,
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }) }));
vi.mock('@/src/lib/vault/active-grant-policy', () => ({ hasActiveVaultGrant: h.custody }));
vi.mock('@/src/lib/github/connector', () => ({
  resolveActiveGrant: h.grant, oauthVaultField: h.oauthField, vaultField: h.field,
}));
vi.mock('@/src/lib/google/connector', () => ({ resolveActiveGrant: h.grant, oauthVaultField: h.oauthField }));
vi.mock('@/src/lib/quickbooks/connector', () => ({ resolveActiveGrant: h.grant, vaultField: h.field }));
vi.mock('@/src/lib/discord/connector', () => ({ resolveActiveGrant: h.grant, vaultField: h.field }));
vi.mock('@/src/lib/typesafe/connector', () => ({ resolveActiveGrant: h.grant, vaultField: h.field }));
vi.mock('@/src/lib/gcp/connector', () => ({ resolveActiveGrant: h.grant, vaultField: h.field }));
vi.mock('@/src/lib/stripe/connector-core', () => ({ stripe: { resolveActiveGrant: h.grant, vaultField: h.field } }));
vi.mock('@/src/lib/warp/connector', () => ({
  warpConnector: { resolveActiveGrant: h.grant }, warpKeyField: h.field, WARP_CONNECTOR_DID: 'did:imajin:warp-connector',
}));
import { httpConnectorAuthority, httpCredentialAuthorized } from '../http-connector-authority';

beforeEach(() => vi.resetAllMocks());
describe('HTTP adapters share the connector call predicates', () => {
  it.each(['github', 'google', 'quickbooks', 'discord', 'typesafe', 'gcp', 'stripe', 'warp'])(
    'reuses %s authorization and never invokes credential loading', async provider => {
      const adapter = await httpConnectorAuthority(provider);
      expect(adapter?.grant).toBe(h.grant);
      h.grant.mockResolvedValue(true);
      expect(await adapter!.grant('did:imajin:owner', `${provider}:scope`)).toBe(true);
      h.custody.mockResolvedValue(true);
      expect(await httpCredentialAuthorized(adapter!, 'did:imajin:owner')).toBe(true);
      expect(h.custody).toHaveBeenCalledWith(expect.any(String),
        provider === 'warp' ? 'did:imajin:warp-connector' : 'did:imajin:node');
    },
  );
  it('does not invent a call gate for an unknown provider', async () => {
    expect(await httpConnectorAuthority('unknown')).toBeUndefined();
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.custody).not.toHaveBeenCalled();
  });
  it('checks both configured GitHub credential paths without loading either', async () => {
    const adapter = await httpConnectorAuthority('github');
    h.custody.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await httpCredentialAuthorized(adapter!, 'did:imajin:owner')).toBe(true);
    expect(h.custody.mock.calls).toEqual([
      ['oauth:did:imajin:owner', 'did:imajin:node'], ['credential:did:imajin:owner', 'did:imajin:node'],
    ]);
    h.custody.mockResolvedValue(false);
    expect(await httpCredentialAuthorized(adapter!, 'did:imajin:owner')).toBe(false);
  });
  it('does not reinterpret a failed custody metadata read as no credential', async () => {
    h.custody.mockRejectedValue(new Error('Store unavailable'));
    const adapter = await httpConnectorAuthority('typesafe');
    await expect(httpCredentialAuthorized(adapter!, 'did:imajin:owner')).rejects.toThrow('Store unavailable');
  });
});
