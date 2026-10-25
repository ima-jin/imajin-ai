import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const did = 'did:imajin:org';
const sessionDid = 'did:imajin:operator';
const mocks = vi.hoisted(() => ({
  identity: {
    id: 'did:imajin:org',
    name: 'GBS',
    handle: 'gbs',
    scope: 'group',
    tier: 'preliminary',
  },
  memberships: [] as { role: string }[],
  profile: { claimedBy: null as string | null, claimStatus: null as string | null },
}));

vi.mock('@/src/db', () => {
  function from(table: { id?: string; identityDid?: string; did?: string }) {
    return {
      where: () => {
        if (table.id) return { limit: async () => [mocks.identity] };
        if (table.identityDid) return { limit: async () => mocks.memberships };
        if (table.did) return { limit: async () => [mocks.profile] };
        return Promise.resolve([{ connCount: 0, attCount: 0 }]);
      },
    };
  }
  return {
    identities: { id: 'identities' },
    identityMembers: { identityDid: 'members', memberDid: 'memberDid', removedAt: 'removedAt' },
    profiles: { did: 'profiles', claimedBy: 'claimedBy' },
    connections: { didA: 'didA', didB: 'didB', disconnectedAt: 'disconnectedAt' },
    attestations: { issuerDid: 'issuerDid', subjectDid: 'subjectDid', revokedAt: 'revokedAt' },
    db: { select: () => ({ from }) },
  };
});
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));
vi.mock('../components/IdentityOwner', () => ({ default: () => null }));

import IdentityDetail from '../components/IdentityDetail';

async function editHref() {
  const html = renderToStaticMarkup(await IdentityDetail({ did, sessionDid }));
  return /<a href="([^"]+)"[^>]*>Edit<\/a>/.exec(html)?.[1] ?? null;
}

beforeEach(() => {
  mocks.identity.scope = 'group';
  mocks.identity.tier = 'preliminary';
  mocks.memberships = [];
  mocks.profile = { claimedBy: null, claimStatus: null };
});

describe('IdentityDetail Edit routing', () => {
  describe.each([
    ['owner', 'group'],
    ['admin', 'group'],
    ['owner', 'business'],
    ['admin', 'business'],
  ])('%s authority on %s', (role, scope) => {
    beforeEach(() => {
      mocks.identity.scope = scope;
    });
    it.each(['soft', 'preliminary', 'established'])(
      'routes an unclaimed created org at tier %s to its owner editor',
      async (tier) => {
        mocks.identity.tier = tier;
        mocks.memberships = [{ role }];
        expect(await editHref()).toBe('/auth/settings');
      },
    );

    it('takes precedence over the unclaimed stub state', async () => {
      mocks.memberships = [{ role }];
      mocks.profile.claimStatus = 'unclaimed';
      expect(await editHref()).toBe('/auth/settings');
    });
  });

  it('routes a stub maintainer to the stubs editor', async () => {
    mocks.identity.scope = 'business';
    mocks.memberships = [{ role: 'maintainer' }];
    mocks.profile.claimStatus = 'unclaimed';
    expect(await editHref()).toBe(`/auth/stubs/${did}`);
  });

  it.each([null, 'unclaimed', 'pending', 'claimed'])(
    'does not show Edit without a role, even with claimStatus %s',
    async (claimStatus) => {
      mocks.profile.claimStatus = claimStatus;
      expect(await editHref()).toBeNull();
    },
  );

  it.each(['member', 'client', 'vendor', 'partner'])(
    'does not grant Edit to a %s on an unclaimed org',
    async (role) => {
      mocks.memberships = [{ role }];
      expect(await editHref()).toBeNull();
    },
  );

  it('does not send a claimed created org to the stubs editor', async () => {
    mocks.profile.claimedBy = sessionDid;
    expect(await editHref()).toBeNull();
  });

  it('keeps the actor acting-as profile editor route', async () => {
    mocks.identity.scope = 'actor';
    expect(await editHref()).toBe(`/profile/edit?did=${encodeURIComponent(did)}`);
  });

  it('keeps the personal profile editor route', async () => {
    mocks.identity.scope = 'actor';
    const html = renderToStaticMarkup(await IdentityDetail({ did, sessionDid: did }));
    expect(html).toContain('href="/profile/edit"');
  });
});
