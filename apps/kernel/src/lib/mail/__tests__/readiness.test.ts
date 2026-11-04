import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ status: vi.fn(), binding: vi.fn() }));
vi.mock('../postal-domains', () => ({ getMailDomainStatus: state.status }));
vi.mock('@/src/lib/domains/service', () => ({ resolveVerifiedDomain: state.binding }));
import { isDomainMailReady } from '../readiness';
import { statusFixture } from './postal-fixture';

beforeEach(() => {
  vi.clearAllMocks();
  state.status.mockResolvedValue(statusFixture(true));
  state.binding.mockResolvedValue({ zoneOwner: 'did:owner' });
});
describe('domain mail readiness', () => {
  it('requires persisted Postal verification AND the current owner binding', async () => {
    expect(await isDomainMailReady('did:owner', 'example.org')).toBe(true);
    expect(state.status).toHaveBeenCalledWith('did:owner', 'example.org');
    expect(state.binding).toHaveBeenCalledWith('example.org');
  });
  it.each([null, { state: 'pending' }, { state: 'disabled' },
    { state: 'verified', ownershipVerified: false, dnsOk: true },
    { state: 'verified', ownershipVerified: true, dnsOk: false }])('rejects unready stored state %j', async status => {
    state.status.mockResolvedValue(status);
    expect(await isDomainMailReady('did:owner', 'example.org')).toBe(false);
    expect(state.binding).not.toHaveBeenCalled();
  });
  it.each([null, { zoneOwner: 'did:other' }])('rejects revoked/expired or foreign binding %j', async binding => {
    state.binding.mockResolvedValue(binding);
    expect(await isDomainMailReady('did:owner', 'example.org')).toBe(false);
  });
  it('fails closed on storage or binding errors', async () => {
    state.status.mockRejectedValueOnce(new Error('unavailable'));
    expect(await isDomainMailReady('did:owner', 'example.org')).toBe(false);
    state.binding.mockRejectedValue(new Error('unavailable'));
    expect(await isDomainMailReady('did:owner', 'example.org')).toBe(false);
  });
});
