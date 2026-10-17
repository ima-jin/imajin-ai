import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as object[], issue: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows }) }) }) },
  identities: { id: 'id' }, registryApps: { ownerDid: 'ownerDid', appDid: 'appDid', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@/src/lib/domains/service', () => ({
  normalizeDomain: (input: string) => input.toLowerCase(), issueImajinDomain: mocks.issue,
}));
import { provisionAppDomain, validateProvisionOwner } from '../provision-domain';
beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; });
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
  it('propagates a missing organization key grant rather than succeeding unsigned', async () => {
    mocks.rows = [{ ownerDid: 'did:gbs' }]; mocks.issue.mockRejectedValueOnce(new Error('missing org grant'));
    await expect(provisionAppDomain('did:app', 'gbs')).rejects.toThrow('missing org grant');
  });
});
