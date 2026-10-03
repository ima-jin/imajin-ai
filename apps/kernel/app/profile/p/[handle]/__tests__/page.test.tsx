/**
 * `profile/p/[handle]/page.tsx` (#2434) — the links lookup and the registry
 * app read are both driven by `resolveEnabledApps`, not the legacy
 * `featureToggles.links` field alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getLinks: vi.fn(),
  getIdentityInfo: vi.fn(),
  resolveRegistryAppsBySlug: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: () => 'https://node.test/profile' }));
vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveRegistryAppsBySlug: mocks.resolveRegistryAppsBySlug }));
vi.mock('../../../lib/profile-data', () => ({
  getViewerDid: vi.fn().mockResolvedValue(null),
  getProfile: mocks.getProfile,
  getProfileCounts: vi.fn().mockResolvedValue({ followers: 0, following: 0, connections: 0 }),
  getFollowStatus: vi.fn().mockResolvedValue(false),
  isConnected: vi.fn().mockResolvedValue(false),
  getLinks: mocks.getLinks,
  getIdentityInfo: mocks.getIdentityInfo,
}));
vi.mock('../../../lib/profile-utils', () => ({ getScopeEmoji: () => '' }));
vi.mock('../../../components/GatedProfile', () => ({ GatedProfile: () => null }));
vi.mock('../../../components/profiles/ActorProfile', () => ({ ActorProfile: () => null }));
vi.mock('../../../components/profiles/BusinessProfile', () => ({ BusinessProfile: () => null }));
vi.mock('../../../components/profiles/CommunityProfile', () => ({ CommunityProfile: () => null }));
vi.mock('../../../components/profiles/FamilyProfile', () => ({ FamilyProfile: () => null }));

import ProfilePage from '../page';

const LINK_ITEMS = [{ title: 'Site', url: 'https://example.com' }];

function profileWith(featureToggles: Record<string, unknown>) {
  return { did: 'did:imajin:abc', handle: 'ryan', displayName: 'Ryan', featureToggles };
}

async function renderProps(featureToggles: Record<string, unknown>) {
  mocks.getProfile.mockResolvedValue(profileWith(featureToggles));
  const element = (await ProfilePage({ params: Promise.resolve({ handle: 'ryan' }) })) as ReactElement;
  return element.props as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLinks.mockResolvedValue(LINK_ITEMS);
  mocks.resolveRegistryAppsBySlug.mockResolvedValue([]);
  // The viewer is anonymous, so use a public scope (business) to get past the connection gate.
  mocks.getIdentityInfo.mockResolvedValue({ scope: 'business', subtype: null, tier: 'established', chainVerified: true });
});

describe('ProfilePage links check (#2434)', () => {
  it('loads links for a profile that enabled links only via enabledApps (legacy field absent)', async () => {
    const props = await renderProps({ enabledApps: ['links'] });

    expect(mocks.getLinks).toHaveBeenCalledWith('ryan');
    expect(props.links).toEqual(LINK_ITEMS);
  });

  it('still loads links for a legacy profile, keyed by the stored legacy handle value', async () => {
    await renderProps({ links: 'legacy-handle' });

    expect(mocks.getLinks).toHaveBeenCalledWith('legacy-handle');
  });

  it('does not load links when links is not enabled by either shape', async () => {
    const props = await renderProps({ coffee: 'ryan', enabledApps: ['events'] });

    expect(mocks.getLinks).not.toHaveBeenCalled();
    expect(props.links).toEqual([]);
  });

  it('does not load links when the legacy field is explicitly null and enabledApps lacks it', async () => {
    await renderProps({ links: null });

    expect(mocks.getLinks).not.toHaveBeenCalled();
  });

  it('asks the registry for the resolved enabled apps plus the events/market widget apps', async () => {
    await renderProps({ coffee: 'ryan', enabledApps: ['learn'] });

    const slugs = mocks.resolveRegistryAppsBySlug.mock.calls[0][0] as string[];
    expect([...slugs].sort()).toEqual(['coffee', 'events', 'learn', 'market']);
  });

  it('passes only owner-enabled registry apps as serviceApps, while registryApps keeps the widget apps', async () => {
    const nav = (slug: string) => ({ slug, name: slug, icon: null, entryUrl: null, placements: ['launcher'], requiredScope: null, tier: 'first_party' });
    mocks.resolveRegistryAppsBySlug.mockResolvedValue([nav('coffee'), nav('events')]);

    const props = await renderProps({ coffee: 'ryan' });

    expect((props.serviceApps as Array<{ slug: string }>).map((a) => a.slug)).toEqual(['coffee']);
    expect((props.registryApps as Array<{ slug: string }>).map((a) => a.slug)).toEqual(['coffee', 'events']);
  });
});
