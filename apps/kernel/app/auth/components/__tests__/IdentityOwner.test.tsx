// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { rows } = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock('@/src/db', () => {
  const query = { leftJoin: () => query, where: () => query, limit: rows };
  return {
    db: { select: () => ({ from: () => query }) },
    identities: { id: 'id', name: 'name', handle: 'handle' },
    identityMembers: { identityDid: 'identity_did', memberDid: 'member_did', role: 'role', removedAt: 'removed_at' },
  };
});

import IdentityOwner from '../IdentityOwner';

afterEach(cleanup);

describe('identity current owner', () => {
  it.each([
    { did: 'did:imajin:new', name: 'New owner', handle: 'new', label: 'New owner' },
    { did: 'did:imajin:new', name: null, handle: 'new', label: 'new' },
    { did: 'did:imajin:new', name: null, handle: null, label: 'did:imajin:new' },
  ])('resolves and displays $label from active ownership', async (owner) => {
    rows.mockResolvedValue([owner]);
    render(await IdentityOwner({ groupDid: 'did:imajin:group' }));
    expect(screen.getAllByText(owner.label).length).toBeGreaterThan(0);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/auth/groups/did%3Aimajin%3Agroup/ownership');
  });

  it('does not invent an owner if none exists', async () => {
    rows.mockResolvedValue([]);
    expect(await IdentityOwner({ groupDid: 'did:imajin:group' })).toBeNull();
  });
});
