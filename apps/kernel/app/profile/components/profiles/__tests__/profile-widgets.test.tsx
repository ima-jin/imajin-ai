// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProfileViewProps } from '../../../lib/types';
import type { NavApp } from '@/src/lib/kernel/app-nav';
import { fixtureStudio } from '@/src/lib/kernel/__tests__/fixtures/third-party-app';

const state = vi.hoisted(() => ({ enabledServices: [] as string[], members: [] as Array<{ did: string; role: string }> }));
vi.mock('../../../lib/profile-data', () => ({
  getForestConfig: async () => ({ enabledServices: state.enabledServices }),
  getViewerMembership: async () => null,
  getMembersByRole: async () => state.members,
}));
vi.mock('@imajin/auth', () => ({ isVerifiedTier: () => true }));
vi.mock('@imajin/config', () => ({ profilePath: (handle: string) => `/profile/${handle}` }));
vi.mock('../../ScopeHeader', () => ({ ScopeHeader: () => null }));
vi.mock('../../ProfileStats', () => ({ ProfileStats: () => null }));
vi.mock('../../ContactCard', () => ({ ContactCard: () => null }));
vi.mock('../../ServiceLinks', () => ({ ServiceLinks: () => null }));
vi.mock('../../MemberList', () => ({ MemberList: () => null }));
vi.mock('../../BusinessDetails', () => ({ BusinessDetails: () => null }));
vi.mock('../../StubActions', () => ({ StubActions: () => null }));
vi.mock('../../StubGallery', () => ({ StubGallery: () => null }));
vi.mock('../../JoinButton', () => ({ JoinButton: () => null }));
vi.mock('../../FollowButton', () => ({ FollowButton: () => null }));
vi.mock('../../CopyDid', () => ({ CopyDid: () => null }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../CommunityChat', () => ({ CommunityChat: () => <p>Member chat</p> }));
vi.mock('../../UpcomingEvents', () => ({ UpcomingEvents: () => <p>Specialized events</p> }));
vi.mock('../../MarketItems', () => ({ MarketItems: () => <p>Specialized market</p> }));

import { ActorProfile } from '../ActorProfile';
import { BusinessProfile } from '../BusinessProfile';
import { FamilyProfile } from '../FamilyProfile';
import { CommunityProfile } from '../CommunityProfile';
import { ProfileWidget } from '../../ProfileWidgets';

const fixture: NavApp = {
  ...fixtureStudio, featured: true,
};
function props(scope: ProfileViewProps['identity']['scope'] = 'actor'): ProfileViewProps {
  return {
    profile: { did: 'did:imajin:owner', handle: 'owner', displayName: 'Owner', createdAt: '',
      featureToggles: { enabledApps: [fixture.slug] } },
    identity: { scope, subtype: null, tier: 'established', chainVerified: true },
    viewer: { viewerDid: 'did:imajin:owner', isSelf: true, isConnected: false, isFollowing: false },
    counts: { followers: 0, following: 0, connections: 0 }, links: [], serviceApps: [], registryApps: [fixture],
  };
}
function expectStudioLink() {
  const link = screen.getByRole('link', { name: 'Studio showcase' });
  const url = new URL(link.getAttribute('href')!);
  expect(url.origin).toBe('https://studio.example.test');
  expect(url.pathname).toBe('/profile/studio');
  expect(url.searchParams.get('did')).toBe('did:imajin:owner');
  expect(url.searchParams.get('handle')).toBe('owner');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
}

afterEach(() => {
  cleanup();
  state.enabledServices = [];
  state.members = [];
  globalThis.history.replaceState(null, '', '/');
});

describe('registry-only profile widget UI', () => {
  it('renders a declared third-party widget in the actor profile only after explicit owner opt-in', () => {
    const value = props();
    const view = render(<ActorProfile {...value} />);
    expectStudioLink();
    value.profile.featureToggles = { enabledApps: [], show_events: true, show_market_items: true };
    view.rerender(<ActorProfile {...value} />);
    expect(screen.queryByRole('link', { name: 'Studio showcase' })).toBeNull();
    value.profile.featureToggles = undefined;
    view.rerender(<ActorProfile {...value} />);
    expect(screen.queryByRole('link', { name: 'Studio showcase' })).toBeNull();
  });
  it.each(['business', 'family'] as const)('uses forest enabled_services, not actor toggles, on %s profiles', async (scope) => {
    const component = scope === 'business' ? BusinessProfile : FamilyProfile;
    const view = render(await component(props(scope)));
    expect(screen.queryByRole('link', { name: 'Studio showcase' })).toBeNull();
    state.enabledServices = [fixture.slug];
    view.rerender(await component(props(scope)));
    expectStudioLink();
  });
  it('keeps family widgets private from non-members', async () => {
    state.enabledServices = [fixture.slug];
    const value = props('family');
    value.viewer = { ...value.viewer, isSelf: false, viewerDid: 'did:imajin:outsider' };
    render(await FamilyProfile(value));
    expect(screen.queryByRole('link', { name: 'Studio showcase' })).toBeNull();
  });
  it('renders an arbitrary community widget tab and its actual link content', async () => {
    state.enabledServices = [fixture.slug, 'chat'];
    render(await CommunityProfile(props('community')));
    expect(screen.queryByRole('link', { name: 'Studio showcase' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Studio showcase/ }));
    expectStudioLink();
    expect(globalThis.location.hash).toBe('#app:fixture-studio');
    fireEvent.click(screen.getByRole('button', { name: /Overview/ }));
    expect(screen.queryByRole('link', { name: 'Studio showcase' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Members/ }));
  });
  it('does not create community tabs from registration, featuring or actor toggles', async () => {
    render(await CommunityProfile(props('community')));
    expect(screen.queryByRole('button', { name: /Studio showcase/ })).toBeNull();
  });
  it('defensively rejects unsafe entries and preserves specialized renderers', () => {
    const { profile } = props();
    const view = render(<ProfileWidget app={{ ...fixture, entryUrl: 'javascript:alert(1)' }} profile={profile} viewerDid={null} />);
    expect(screen.queryByRole('link')).toBeNull();
    view.rerender(<ProfileWidget app={{ ...fixture, slug: 'events', entryUrl: '/events' }} profile={profile} viewerDid={null} />);
    expect(screen.getByText('Specialized events')).toBeTruthy();
    view.rerender(<ProfileWidget app={{ ...fixture, slug: 'market', entryUrl: '/market' }} profile={profile} viewerDid={null} />);
    expect(screen.getByText('Specialized market')).toBeTruthy();
    view.rerender(<ProfileWidget app={{ ...fixture, entryUrl: 'https://studio.example.test/start?x=1' }} profile={profile} viewerDid={null} />);
    expectStudioLink();
  });
});
