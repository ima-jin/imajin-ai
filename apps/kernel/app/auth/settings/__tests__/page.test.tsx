// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { effective, rows, redirect, canManage } = vi.hoisted(() => ({
  effective: vi.fn(), rows: vi.fn(), redirect: vi.fn(() => { throw new Error('redirect'); }), canManage: vi.fn(),
}));
vi.mock('@/src/lib/domains/access', () => ({ canManageIdentityDomains: canManage }));
vi.mock('@/app/auth/lib/get-effective-did', () => ({ getEffectiveDid: effective }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: rows }) }) }) },
  identities: { scope: 'scope', id: 'id' },
  identityMembers: { role: 'role', identityDid: 'identity_did', memberDid: 'member_did', removedAt: 'removed_at' },
}));
vi.mock('../../components/IdentitySettingsPanel', () => ({ default: () => <div>other-settings</div> }));
vi.mock('../../components/DomainsSection', () => ({
  default: ({ did }: { did: string }) => <div>domains:{did}</div>,
}));
vi.mock('../../components/IdentityOwnershipPanel', () => ({
  default: ({ groupDid }: { groupDid: string }) => <div>ownership:{groupDid}</div>,
}));
import SettingsPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  effective.mockResolvedValue({ sessionDid: 'did:imajin:alice', effectiveDid: 'did:imajin:group' });
  canManage.mockResolvedValue(true);
});
afterEach(cleanup);

describe('identity settings ownership integration', () => {
  it('redirects anonymous visitors', async () => {
    effective.mockResolvedValue({ sessionDid: null });
    await expect(SettingsPage()).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenCalledWith('/auth');
  });
  it('allows an active admin to manage domains and review ownership, but not edit other settings', async () => {
    rows.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role: 'admin' }]);
    render(await SettingsPage());
    expect(screen.getByText('ownership:did:imajin:group')).toBeTruthy();
    expect(screen.getByText('domains:did:imajin:group')).toBeTruthy();
    expect(screen.queryByText('other-settings')).toBeNull();
  });
  it('does not expose domain management through a forged effective DID or removed membership', async () => {
    canManage.mockResolvedValue(false);
    rows.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([]);
    render(await SettingsPage());
    expect(canManage).toHaveBeenCalledWith('did:imajin:group', 'did:imajin:alice');
    expect(screen.queryByText(/domains:/)).toBeNull();
    expect(screen.queryByText('other-settings')).toBeNull();
    expect(screen.getByText(/You need owner or admin access/)).toBeTruthy();
  });
  it('requires personal domain authority before rendering its controls', async () => {
    canManage.mockResolvedValue(false);
    effective.mockResolvedValue({ sessionDid: 'did:imajin:alice', effectiveDid: 'did:imajin:other' });
    rows.mockResolvedValueOnce([{ scope: 'actor' }]);
    render(await SettingsPage());
    expect(screen.queryByText(/domains:/)).toBeNull();
    expect(screen.getByText(/You need owner or admin access/)).toBeTruthy();
  });

  it('does not render group ownership or domains for an absent identity', async () => {
    rows.mockResolvedValueOnce([]);
    render(await SettingsPage());
    expect(screen.queryByText(/ownership:/)).toBeNull();
    expect(screen.queryByText(/domains:/)).toBeNull();
    expect(screen.getByText('Account settings are available via the tabs above.')).toBeTruthy();
  });
  it('enables personal domains without rendering group ownership', async () => {
    effective.mockResolvedValue({ sessionDid: 'did:imajin:alice', effectiveDid: 'did:imajin:alice' });
    rows.mockResolvedValueOnce([{ scope: 'actor' }]);
    render(await SettingsPage());
    expect(screen.getByText('domains:did:imajin:alice')).toBeTruthy();
    expect(screen.queryByText(/ownership:/)).toBeNull();
  });

  it('includes ownership above other settings for the owner', async () => {
    rows.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role: 'owner' }]);
    render(await SettingsPage());
    expect(screen.getByText('ownership:did:imajin:group')).toBeTruthy();
    expect(screen.getByText('other-settings')).toBeTruthy();
    expect(screen.getByText('domains:did:imajin:group')).toBeTruthy();
    expect(canManage).toHaveBeenCalledWith('did:imajin:group', 'did:imajin:alice');
  });

  it('lets other members review ownership without exposing owner settings', async () => {
    canManage.mockResolvedValue(false);
    rows.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role: 'member' }]);
    render(await SettingsPage());
    expect(screen.getByText('ownership:did:imajin:group')).toBeTruthy();
    expect(screen.queryByText('other-settings')).toBeNull();
    expect(screen.queryByText(/domains:/)).toBeNull();
  });
});
