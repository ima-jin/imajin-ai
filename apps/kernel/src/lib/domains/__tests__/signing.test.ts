import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({
  nodeDid: vi.fn(), fetch: vi.fn(), limit: vi.fn(), select: vi.fn(), where: vi.fn(),
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
  vi.stubEnv('PLATFORM_DID', 'did:org');
  mocks.nodeDid.mockResolvedValue('did:node');
  mocks.fetch.mockResolvedValue(key);
  mocks.limit.mockResolvedValue([{ id: 'did:org', publicKey }]);
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) });
});
describe('domain attestation signing authority', () => {
  it('uses the existing organization identity and its own grant-backed key', async () => {
    expect(await domainSigningIdentity(true)).toEqual({ issuerDid: 'did:org', privateKey: key });
    expect(mocks.fetch).toHaveBeenCalledWith('did:org', 'did:node', 'domain.issue');
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
    expect(query.sql).toContain('"auth"."identities"."id" =');
    expect(query.params).toContain('did:org');
  });
  it.each(['', '   '])('fails closed without a configured org DID (%j), never selecting by handle alone', async (configuredDid) => {
    vi.stubEnv('PLATFORM_DID', configuredDid);
    await expect(domainSigningIdentity(true)).rejects.toMatchObject({ code: 'issuer_unavailable', status: 503 });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('refuses a renamed or reclaimed handle with a different DID than configured org authority', async () => {
    mocks.limit.mockResolvedValue([{ id: 'did:new-handle-holder', publicKey }]);
    await expect(domainSigningIdentity(true)).rejects.toMatchObject({ code: 'issuer_unavailable' });
    expect(mocks.fetch).not.toHaveBeenCalled();
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
