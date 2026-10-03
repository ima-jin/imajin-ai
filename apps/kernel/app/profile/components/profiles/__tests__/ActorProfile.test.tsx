// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ProfileViewProps } from '../../../lib/types';
import type { NavApp } from '@/src/lib/kernel/app-nav';

vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `https://node.test/${slug}` }));
vi.mock('@imajin/auth', () => ({ isVerifiedTier: () => true }));
vi.mock('../../ScopeHeader', () => ({ ScopeHeader: () => <div /> }));
vi.mock('../../ProfileStats', () => ({ ProfileStats: () => <div /> }));
vi.mock('../../ContactCard', () => ({ ContactCard: () => <div /> }));
vi.mock('../../ServiceLinks', () => ({ ServiceLinks: () => <div /> }));
vi.mock('../../UpcomingEvents', () => ({
  UpcomingEvents: ({ eventsBaseUrl }: { eventsBaseUrl: string }) => <div data-testid="events" data-base={eventsBaseUrl} />,
}));
vi.mock('../../MarketItems', () => ({
  MarketItems: ({ marketBaseUrl }: { marketBaseUrl: string }) => <div data-testid="market" data-base={marketBaseUrl} />,
}));

import { ActorProfile } from '../ActorProfile';

afterEach(() => {
  cleanup();
});

function navApp(slug: string): NavApp {
  return {
    slug,
    name: slug,
    icon: null,
    entryUrl: `/${slug}`,
    placements: ['launcher'],
    requiredScope: null,
    tier: 'first_party',
  };
}

function props(overrides: Partial<ProfileViewProps> = {}): ProfileViewProps {
  return {
    profile: {
      did: 'did:imajin:abc',
      handle: 'ryan',
      displayName: 'Ryan',
      createdAt: new Date().toISOString(),
      featureToggles: { show_events: true, show_market_items: true },
    },
    identity: { scope: 'actor', subtype: 'human', tier: 'established', chainVerified: true },
    viewer: { viewerDid: null, isSelf: false, isConnected: false, isFollowing: false },
    counts: { followers: 0, following: 0, connections: 0 },
    links: [],
    serviceApps: [],
    registryApps: [navApp('events'), navApp('market')],
    ...overrides,
  };
}

describe('ActorProfile — events/market links come from the registry (#2434)', () => {
  it('renders both widgets with the registry-derived base URLs when the apps are registered', () => {
    render(<ActorProfile {...props()} />);

    expect(screen.getByTestId('events').dataset.base).toBe('https://node.test/events');
    expect(screen.getByTestId('market').dataset.base).toBe('https://node.test/market');
  });

  it('drops a widget when its app was pruned from the registry, even with the profile toggle on', () => {
    render(<ActorProfile {...props({ registryApps: [navApp('market')] })} />);

    expect(screen.queryByTestId('events')).toBeNull();
    expect(screen.getByTestId('market')).toBeTruthy();
  });

  it('renders no widgets when the profile toggles are off', () => {
    render(<ActorProfile {...props({ profile: { ...props().profile, featureToggles: {} } })} />);

    expect(screen.queryByTestId('events')).toBeNull();
    expect(screen.queryByTestId('market')).toBeNull();
  });
});
