import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@/src/lib/domains/normalize';
const mocks = vi.hoisted(() => ({ rows: [] as object[], issue: vi.fn(), warn: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('@/src/db', () => {
  const limit = async () => mocks.rows;
  const where = () => ({ limit });
  const from = () => ({ where });
  return {
    db: { select: () => ({ from }) },
    identities: { id: 'id' }, registryApps: { ownerDid: 'ownerDid', appDid: 'appDid', status: 'status' },
  };
});
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@/src/lib/domains/service', () => ({
  normalizeDomain: (input: string) => input.toLowerCase(), issueImajinDomain: mocks.issue,
}));
import { provisionAppDomain, validateProvisionOwner } from '../provision-domain';
beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; mocks.issue.mockResolvedValue(undefined); });
describe('provisioning domain ceremony', () => {
  it('requires an explicit site owner to exist before creating resources', async () => {
    await expect(validateProvisionOwner()).resolves.toBeUndefined();
    await expect(validateProvisionOwner('did:missing')).rejects.toThrow('does not exist');
    mocks.rows = [{ id: 'did:gbs' }];
    await expect(validateProvisionOwner('did:gbs')).resolves.toBeUndefined();
  });
  it('automatically issues dev-gbs to the app’s recorded owner', async () => {
    mocks.rows = [{ ownerDid: 'did:gbs' }];
    await provisionAppDomain('did:app', 'dev-gbs', undefined, 'did:gbs');
    expect(mocks.issue).toHaveBeenCalledWith({ domain: 'dev-gbs.imajin.ai', appDid: 'did:app' });
  });
  it('supports an explicit countersigned host without a TXT shortcut for custom zones', async () => {
    mocks.rows = [{ ownerDid: 'did:gbs' }];
    await provisionAppDomain('did:app', 'gbs', 'dev-gbs.imajin.ai');
    expect(mocks.issue).toHaveBeenCalledWith({ domain: 'dev-gbs.imajin.ai', appDid: 'did:app' });
    await expect(provisionAppDomain('did:app', 'gbs', 'gbs.example')).rejects.toThrow('require TXT');
  });
  it('never uses a retry to transfer an existing app or issue for an inactive app', async () => {
    await expect(provisionAppDomain('did:app', 'gbs')).rejects.toThrow('cannot change');
    mocks.rows = [{ ownerDid: 'did:gbs' }];
    await expect(provisionAppDomain('did:app', 'gbs', undefined, 'did:attacker')).rejects.toThrow('cannot change');
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it.each(['issuer_unavailable', 'credential_unavailable'])('defers %s without logging any provider values, then retries successfully', async (code) => {
    const privateDetail = 'provider-value-must-not-be-logged';
    mocks.rows = [{ ownerDid: 'did:gbs' }];
    mocks.issue.mockRejectedValueOnce(new DomainError(code, privateDetail, 503));
    await expect(provisionAppDomain('did:app', 'gbs', 'dev-gbs.imajin.ai')).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith({}, expect.stringContaining('issuance deferred'));
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(privateDetail);
    await provisionAppDomain('did:app', 'gbs', 'dev-gbs.imajin.ai');
    await provisionAppDomain('did:app', 'gbs', 'dev-gbs.imajin.ai');
    expect(mocks.issue).toHaveBeenCalledTimes(3);
    expect(mocks.issue).toHaveBeenLastCalledWith({ domain: 'dev-gbs.imajin.ai', appDid: 'did:app' });
  });
  it('propagates unexpected failures and ownership conflicts rather than treating them as missing signing prerequisites', async () => {
    mocks.rows = [{ ownerDid: 'did:gbs' }]; mocks.issue.mockRejectedValueOnce(new Error('missing org grant'));
    await expect(provisionAppDomain('did:app', 'gbs')).rejects.toThrow('missing org grant');
    mocks.issue.mockRejectedValueOnce(new DomainError('domain_conflict', 'Already bound', 409));
    await expect(provisionAppDomain('did:app', 'gbs')).rejects.toMatchObject({ code: 'domain_conflict' });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
