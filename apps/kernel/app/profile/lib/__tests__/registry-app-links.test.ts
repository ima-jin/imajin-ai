import { describe, it, expect, vi } from 'vitest';
import type { NavApp } from '@/src/lib/kernel/app-nav';

vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `https://node.test/${slug}` }));

import { resolveRegistryAppUrl, buildCommunityTabs, PROFILE_WIDGET_APP_SLUGS } from '../registry-app-links';

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

describe('resolveRegistryAppUrl (#2434)', () => {
  it('returns the env-aware public URL for an app that has a registry row', () => {
    expect(resolveRegistryAppUrl([navApp('events'), navApp('market')], 'events')).toBe('https://node.test/events');
  });

  it('returns null once the app is gone from the registry (pruned)', () => {
    expect(resolveRegistryAppUrl([navApp('market')], 'events')).toBeNull();
    expect(resolveRegistryAppUrl([], 'market')).toBeNull();
  });

  it('covers exactly the events and market widget apps', () => {
    expect([...PROFILE_WIDGET_APP_SLUGS]).toEqual(['events', 'market']);
  });
});

describe('buildCommunityTabs (#2434)', () => {
  const urls = { eventsUrl: 'https://node.test/events', marketUrl: 'https://node.test/market' };

  it('always includes overview and members', () => {
    expect(buildCommunityTabs({ enabledServices: [], featureToggles: undefined, eventsUrl: null, marketUrl: null })).toEqual([
      'overview',
      'members',
    ]);
  });

  it('shows events via the forest service or the profile toggle, and market only when both are on', () => {
    expect(buildCommunityTabs({ enabledServices: ['events'], featureToggles: undefined, ...urls })).toContain('events');
    expect(buildCommunityTabs({ enabledServices: [], featureToggles: { show_events: true }, ...urls })).toContain('events');
    expect(buildCommunityTabs({ enabledServices: ['market'], featureToggles: undefined, ...urls })).not.toContain('market');
    expect(
      buildCommunityTabs({ enabledServices: ['market'], featureToggles: { show_market_items: true }, ...urls }),
    ).toContain('market');
  });

  it('drops the events/market tabs when their app is no longer in the registry', () => {
    const tabs = buildCommunityTabs({
      enabledServices: ['events', 'market', 'chat'],
      featureToggles: { show_events: true, show_market_items: true },
      eventsUrl: null,
      marketUrl: null,
    });

    expect(tabs).toEqual(['overview', 'chat', 'members']);
  });
});
