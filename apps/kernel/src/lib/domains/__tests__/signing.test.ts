import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
const mocks = vi.hoisted(() => ({
  nodeDid: vi.fn(), fetch: vi.fn(), limit: vi.fn(), select: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  db: { select: mocks.select },
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDidFromConfig: mocks.nodeDid }));
vi.mock('@/src/lib/vault/purpose-credential', () => ({ fetchPurposeCredential: mocks.fetch }));
import { domainSigningIdentity, getImajinOrganization } from '../signing';

const key = '2'.repeat(64);
const publicKey = authCrypto.getPublicKey(key);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', key);
  mocks.nodeDid.mockResolvedValue('did:node');
  mocks.fetch.mockResolvedValue(key);
  mocks.limit.mockResolvedValue([{ id: 'did:org', publicKey }]);
  mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: mocks.limit }) }) });
});
describe('domain attestation signing authority', () => {
  it('uses the existing organization identity and its own grant-backed key', async () => {
    expect(await domainSigningIdentity(true)).toEqual({ issuerDid: 'did:org', privateKey: key });
    expect(mocks.fetch).toHaveBeenCalledWith('did:org', 'did:node', 'domain.issue');
  });
  it('uses only a configured node identity whose key actually matches', async () => {
    expect(await domainSigningIdentity(false)).toEqual({ issuerDid: 'did:node', privateKey: key });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('fails closed when organization or configured node is unavailable', async () => {
    mocks.limit.mockResolvedValue([]);
    await expect(getImajinOrganization()).rejects.toMatchObject({ code: 'issuer_unavailable', status: 503 });
    mocks.nodeDid.mockResolvedValue('');
    await expect(domainSigningIdentity(true)).rejects.toMatchObject({ code: 'issuer_unavailable' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('rejects missing and mismatched node signing keys', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(domainSigningIdentity(false)).rejects.toMatchObject({ code: 'issuer_unavailable' });
    vi.stubEnv('AUTH_PRIVATE_KEY', '3'.repeat(64));
    await expect(domainSigningIdentity(false)).rejects.toMatchObject({ code: 'issuer_unavailable' });
  });
  it('rejects invalid/mismatched org keys and propagates grant denial without node fallback', async () => {
    mocks.fetch.mockResolvedValueOnce('not-a-key').mockResolvedValueOnce('3'.repeat(64))
      .mockRejectedValueOnce(new Error('denied'));
    await expect(domainSigningIdentity(true)).rejects.toMatchObject({ code: 'issuer_unavailable' });
    await expect(domainSigningIdentity(true)).rejects.toMatchObject({ code: 'issuer_unavailable' });
    await expect(domainSigningIdentity(true)).rejects.toThrow('denied');
  });
});
