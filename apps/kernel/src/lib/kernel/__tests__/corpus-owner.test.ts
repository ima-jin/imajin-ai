import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeCorpusOwner, resolveCorpusDid } from '../corpus-owner';
import { introspectGrant } from '../../auth/grants';

vi.mock('../../auth/grants', () => ({ introspectGrant: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('owner grant boundary', () => {
  it.each(['did:imajin:jin', 'did:imajin:ryan'])('requires an owner-issued, target-bound read grant for %s', async principalDid => {
    vi.mocked(introspectGrant).mockResolvedValue({ authorized: false });
    expect(await authorizeCorpusOwner(principalDid, 'did:imajin:org', 'corpus:read')).toBe(false);
    expect(introspectGrant).toHaveBeenCalledWith({
      agentDid: principalDid, delegatorDid: 'did:imajin:org', targetDid: 'did:imajin:org', capability: 'corpus:read',
    });
    vi.mocked(introspectGrant).mockResolvedValue({ authorized: true });
    expect(await authorizeCorpusOwner(principalDid, 'did:imajin:org', 'corpus:read')).toBe(true);
  });
  it('does not substitute read authority for write authority', async () => {
    vi.mocked(introspectGrant).mockImplementation(async params => ({ authorized: params.capability === 'corpus:read' }));
    expect(await authorizeCorpusOwner('did:imajin:jin', 'did:imajin:org', 'corpus:write')).toBe(false);
  });
  it('does not grant on lookup failure', async () => {
    vi.mocked(introspectGrant).mockRejectedValue(new Error('offline'));
    await expect(authorizeCorpusOwner('did:imajin:jin', 'did:imajin:org', 'corpus:read')).rejects.toThrow('offline');
  });
  it('retains personal workspace access without any grant lookup', async () => {
    expect(await resolveCorpusDid('local:workspace', 'did:imajin:ryan')).toBe('did:imajin:ryan');
    expect(await authorizeCorpusOwner('did:imajin:ryan', 'did:imajin:ryan', 'corpus:read')).toBe(true);
    expect(introspectGrant).not.toHaveBeenCalled();
  });
});
