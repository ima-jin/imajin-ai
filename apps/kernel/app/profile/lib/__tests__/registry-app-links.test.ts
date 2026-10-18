import { describe, it, expect } from 'vitest';
import type { NavApp } from '@/src/lib/kernel/app-nav';
import { enabledProfileWidgets, buildCommunityTabs, resolveRegistryAppUrl } from '../registry-app-links';

const app: NavApp = {
  slug: 'fixture-studio', name: 'Fixture Studio', entryUrl: 'https://studio.example.test',
  profileWidget: { path: '/profile/studio', label: 'Studio', icon: 'S' },
  icon: null, placements: [], requiredScope: null, tier: 'third_party',
};
const profile = { did: 'did:imajin:owner', createdAt: '', displayName: 'Owner' };

describe('registry profile widgets', () => {
  it('requires the profile owner to enable a declared app; featuring is not opt-in', () => {
    expect(enabledProfileWidgets([{ ...app, featured: true }], [], profile)).toEqual([]);
    expect(enabledProfileWidgets([app], ['fixture-studio'], profile)).toEqual([app]);
  });
  it('ignores missing declarations and unsafe registered destinations', () => {
    expect(enabledProfileWidgets([{ ...app, profileWidget: null }], [app.slug], profile)).toEqual([]);
    expect(enabledProfileWidgets([{ ...app, entryUrl: 'javascript:alert(1)' }], [app.slug], profile)).toEqual([]);
  });
  it('creates arbitrary app tabs without fixed candidates or collisions with kernel tabs', () => {
    expect(buildCommunityTabs(['chat'], [app]).map((tab) => tab.id)).toEqual([
      'overview', 'app:fixture-studio', 'chat', 'members',
    ]);
    expect(buildCommunityTabs([], [])).toEqual([
      { id: 'overview', label: 'Overview', icon: '🏠' }, { id: 'members', label: 'Members', icon: '👥' },
    ]);
    expect(buildCommunityTabs([], [{ ...app, profileWidget: null }])[1].label).toBe(app.name);
  });
  it('retains safe specialized API-base resolution', () => {
    expect(resolveRegistryAppUrl([], 'events')).toBeNull();
    expect(resolveRegistryAppUrl([{ ...app, slug: 'events', entryUrl: '/events' }], 'events')).toBe('/events');
    expect(resolveRegistryAppUrl([{ ...app, slug: 'events', entryUrl: '/events/list?x=1' }], 'events')).toBeNull();
  });
});
