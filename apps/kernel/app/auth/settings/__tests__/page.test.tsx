// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { effective, rows, redirect } = vi.hoisted(() => ({
  effective: vi.fn(), rows: vi.fn(), redirect: vi.fn(() => { throw new Error('redirect'); }),
}));
vi.mock('@/app/auth/lib/get-effective-did', () => ({ getEffectiveDid: effective }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: rows }) }) }) },
  identities: { scope: 'scope', id: 'id' },
  identityMembers: { role: 'role', identityDid: 'identity_did', memberDid: 'member_did', removedAt: 'removed_at' },
}));
vi.mock('../../components/IdentitySettingsPanel', () => ({ default: () => <div>other-settings</div> }));
vi.mock('../../components/IdentityOwnershipPanel', () => ({
  default: ({ groupDid }: { groupDid: string }) => <div>ownership:{groupDid}</div>,
}));
import SettingsPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  effective.mockResolvedValue({ sessionDid: 'did:imajin:alice', effectiveDid: 'did:imajin:group' });
});
afterEach(cleanup);

describe('identity settings ownership integration', () => {
  it('redirects anonymous visitors', async () => {
    effective.mockResolvedValue({ sessionDid: null });
    await expect(SettingsPage()).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenCalledWith('/auth');
  });

  it.each([{ identity: [] }, { identity: [{ scope: 'actor' }] }])('does not render group ownership for personal or absent identity $identity', async ({ identity }) => {
    rows.mockResolvedValueOnce(identity);
    render(await SettingsPage());
    expect(screen.queryByText(/ownership:/)).toBeNull();
    expect(screen.getByText('Account settings are available via the tabs above.')).toBeTruthy();
  });

  it('includes ownership above other settings for the owner', async () => {
    rows.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role: 'owner' }]);
    render(await SettingsPage());
    expect(screen.getByText('ownership:did:imajin:group')).toBeTruthy();
    expect(screen.getByText('other-settings')).toBeTruthy();
  });

  it('lets other members review ownership without exposing owner settings', async () => {
    rows.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role: 'member' }]);
    render(await SettingsPage());
    expect(screen.getByText('ownership:did:imajin:group')).toBeTruthy();
    expect(screen.queryByText('other-settings')).toBeNull();
  });
});
