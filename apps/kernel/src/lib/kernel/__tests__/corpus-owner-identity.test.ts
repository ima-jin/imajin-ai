import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCorpusDid, grantedCorpusOwners } from '../corpus-owner';
import { resolveOrMintIdentity } from '../../registry/identity-alias';
import { identityRepo } from '../../registry/identity-repo';
import { prepareMechanicalAttestation } from '../../auth/emit-mechanical-attestation';
import { introspectGrant } from '../../auth/grants';
const mocks = vi.hoisted(() => {
  const rows = vi.fn(async () => [{ scope: 'business', suspendedAt: null }]);
  const grantRows = vi.fn(async () => [{ did: 'did:imajin:org' }]);
  const values = vi.fn();
  const tx = {
    execute: vi.fn(), insert: vi.fn(() => ({ values })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: rows }) }) })),
  };
  return { tx, rows, values, grantRows };
});
vi.mock('@/src/db', () => ({
  db: {
    transaction: async (fn: (tx: typeof mocks.tx) => unknown) => fn(mocks.tx),
    select: () => ({ from: () => ({ where: mocks.grantRows }) }),
  },
  attestations: {}, identities: { scope: 'scope', suspendedAt: 'suspended_at', id: 'id' },
  delegationGrants: { delegatorDid: 'delegator', agentDid: 'agent', status: 'status', expiresAt: 'expires' },
}));
vi.mock('../../registry/identity-alias', () => ({ resolveOrMintIdentity: vi.fn() }));
vi.mock('../../registry/identity-repo', () => ({ identityRepo: vi.fn(() => ({ fixture: true })) }));
vi.mock('../../auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: vi.fn(async () => ({ id: 'att_fixture' })) }));
vi.mock('../../auth/grants', () => ({ introspectGrant: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveOrMintIdentity).mockResolvedValue({ did: 'did:imajin:org', created: true, minted: true, metadata: {} });
  mocks.rows.mockResolvedValue([{ scope: 'business', suspendedAt: null }]);
});
describe('source group identity flow', () => {
  it('reuses the registry resolver under a transaction lock, with signed creation and no controller or grant creation', async () => {
    expect(await resolveCorpusDid('github:IMA-JIN/imajin-ai', 'did:imajin:jin')).toBe('did:imajin:org');
    expect(identityRepo).toHaveBeenCalledWith(null, mocks.tx);
    expect(resolveOrMintIdentity).toHaveBeenCalledWith({ fixture: true }, {
      namespace: 'github', ref: 'org:ima-jin', type: 'organization', metadata: {},
    });
    expect(mocks.tx.execute).toHaveBeenCalledOnce();
    expect(prepareMechanicalAttestation).toHaveBeenCalledWith(expect.objectContaining({ type: 'identity.created', subjectDid: 'did:imajin:org' }));
    expect(mocks.values).toHaveBeenCalledWith({ id: 'att_fixture' });
    expect(introspectGrant).not.toHaveBeenCalled();
  });
  it('does not mint another identity or attestation when the group exists', async () => {
    vi.mocked(resolveOrMintIdentity).mockResolvedValue({ did: 'did:imajin:org', created: false, minted: false, metadata: {} });
    expect(await resolveCorpusDid('github:ima-jin/events', 'did:imajin:ryan')).toBe('did:imajin:org');
    expect(prepareMechanicalAttestation).not.toHaveBeenCalled();
  });
  it('propagates registry failures instead of using the principal DID', async () => {
    vi.mocked(resolveOrMintIdentity).mockResolvedValue({ error: 'identity unavailable', status: 500 });
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).rejects.toThrow('identity unavailable');
  });
  it('rejects an alias to a personal identity', async () => {
    mocks.rows.mockResolvedValue([{ scope: 'actor', suspendedAt: null }]);
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).rejects.toThrow('active group');
  });
  it('rejects an alias without a backing identity', async () => {
    mocks.rows.mockResolvedValue([]);
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).rejects.toThrow('active group');
  });
  it('discovers only owners with active read authority, not unrelated or duplicate grants', async () => {
    mocks.grantRows.mockResolvedValue([{ did: 'did:imajin:org' }, { did: 'did:imajin:org' }, { did: 'did:imajin:other' }]);
    vi.mocked(introspectGrant).mockImplementation(async params => ({ authorized: params.delegatorDid === 'did:imajin:org' }));
    expect(await grantedCorpusOwners('did:imajin:ryan')).toEqual(['did:imajin:org']);
    expect(introspectGrant).toHaveBeenCalledTimes(2);
  });
});
