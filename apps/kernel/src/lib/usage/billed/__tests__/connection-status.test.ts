import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sealed, pending, granted } = vi.hoisted(() => ({
  sealed: vi.fn(), pending: vi.fn(), granted: vi.fn(),
}));
vi.mock('@/src/lib/anthropic/billing-connector', () => ({
  billingKeySealed: sealed, billingKeyPending: pending, resolveActiveGrant: granted,
}));
vi.mock('@/src/lib/openai/billing-connector', () => ({
  billingKeySealed: sealed, billingKeyPending: pending, resolveActiveGrant: granted,
}));
import { readBillingConnections } from '../connection-status';

beforeEach(() => {
  vi.resetAllMocks();
  sealed.mockResolvedValue(false); pending.mockResolvedValue(false); granted.mockResolvedValue(false);
});
describe('billing connection presence without unsealing', () => {
  it.each([
    [false, false, false, 'not connected'],
    [false, true, false, 'awaiting owner approval'],
    [true, false, false, 'scope not granted'],
    [true, false, true, 'connected'],
  ])('reports seal=%s pending=%s grant=%s as %s for each provider', async (ready, waiting, consent, status) => {
    sealed.mockResolvedValue(ready); pending.mockResolvedValue(waiting); granted.mockResolvedValue(consent);
    expect(await readBillingConnections('did:imajin:owner')).toEqual([
      { provider: 'anthropic', status }, { provider: 'openai', status },
    ]);
    if (ready && !waiting) {
      expect(granted).toHaveBeenCalledWith('did:imajin:owner', 'anthropic:billing');
      expect(granted).toHaveBeenCalledWith('did:imajin:owner', 'openai:billing');
    } else expect(granted).not.toHaveBeenCalled();
  });
  it('reports a failed check as unavailable, not disconnected', async () => {
    pending.mockRejectedValueOnce(new Error('unavailable'));
    expect(await readBillingConnections('did:imajin:owner')).toEqual([
      { provider: 'anthropic', status: 'unavailable' }, { provider: 'openai', status: 'not connected' },
    ]);
  });
});
