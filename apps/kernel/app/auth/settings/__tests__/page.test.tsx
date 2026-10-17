import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({ effective: vi.fn(), canManage: vi.fn(), limit: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) },
  identities: {}, identityMembers: {},
}));
vi.mock('@/app/auth/lib/get-effective-did', () => ({ getEffectiveDid: mocks.effective }));
vi.mock('@/src/lib/domains/access', () => ({ canManageIdentityDomains: mocks.canManage }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));
vi.mock('../../components/IdentitySettingsPanel', () => ({ default: () => null }));
vi.mock('../../components/DomainsSection', () => ({ default: () => null }));

import SettingsPage from '../page';
import DomainsSection from '../../components/DomainsSection';
import IdentitySettingsPanel from '../../components/IdentitySettingsPanel';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.effective.mockResolvedValue({ sessionDid: 'did:imajin:person', effectiveDid: 'did:imajin:group' });
  mocks.canManage.mockResolvedValue(true);
});

describe('domain settings access', () => {
  it('redirects unauthenticated visitors', async () => {
    mocks.effective.mockResolvedValue({ sessionDid: null, effectiveDid: null });
    await expect(SettingsPage()).rejects.toThrow('redirect');
  });

  it('enables domain management for individual identities', async () => {
    mocks.effective.mockResolvedValue({ sessionDid: 'did:imajin:person', effectiveDid: 'did:imajin:person' });
    mocks.limit.mockResolvedValueOnce([{ scope: 'actor' }]);
    const page = await SettingsPage();
    expect(page.type).toBe(DomainsSection);
    expect(page.props.did).toBe('did:imajin:person');
  });

  it.each(['owner', 'admin'])('enables group domains for an active %s without widening existing settings', async (role) => {
    mocks.limit.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role }]);
    const page = await SettingsPage();
    const children = page.props.children as ReactElement[];
    expect(children[0].type).toBe(DomainsSection);
    expect(children[0].props.did).toBe('did:imajin:group');
    if (role === 'owner') expect(children[1].type).toBe(IdentitySettingsPanel);
    else expect(children[1]).toBe(false);
    expect(mocks.canManage).toHaveBeenCalledWith('did:imajin:group', 'did:imajin:person');
  });

  it('rejects a forged effective DID or removed membership through the shared helper', async () => {
    mocks.limit.mockResolvedValue([{ scope: 'business' }]);
    mocks.canManage.mockResolvedValue(false);
    const page = await SettingsPage();
    expect(page.props.children).toContain('You need owner or admin access');
  });
});
