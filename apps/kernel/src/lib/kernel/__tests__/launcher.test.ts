/**
 * Tests for apps/kernel/src/lib/kernel/launcher.ts (#2434).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPublicUrl, SERVICES } from '@imajin/config';

const mocks = vi.hoisted(() => ({ resolveLauncherApps: vi.fn() }));

vi.mock('../app-nav', () => ({ resolveLauncherApps: mocks.resolveLauncherApps }));

import { buildLauncherEntries } from '../launcher';
import type { NavApp } from '../app-nav';

function navApp(overrides: Partial<NavApp>): NavApp {
  return {
    slug: 'coffee',
    name: 'Coffee',
    icon: null,
    entryUrl: '/coffee',
    placements: ['launcher'],
    requiredScope: null,
    tier: 'first_party',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveLauncherApps.mockResolvedValue([]);
});

describe('buildLauncherEntries (#2434)', () => {
  it('lists a registry-only app that has no services.ts entry', async () => {
    expect(SERVICES.some((s) => s.name === 'registry-only-app')).toBe(false);
    mocks.resolveLauncherApps.mockResolvedValue([navApp({ slug: 'registry-only-app', name: 'Registry Only', icon: '🧪' })]);

    const entries = await buildLauncherEntries();

    expect(entries.find((e) => e.name === 'registry-only-app')).toEqual({
      name: 'registry-only-app',
      label: 'Registry Only',
      description: 'Registry Only',
      icon: '🧪',
      // Neutral defaults — services.ts has nothing to say about this app.
      visibility: 'public',
      category: 'core',
      url: buildPublicUrl('registry-only-app'),
      source: 'registry',
    });
  });

  it('falls back to a default icon for a registry app with neither an icon nor a services.ts hint', async () => {
    mocks.resolveLauncherApps.mockResolvedValue([navApp({ slug: 'registry-only-app', name: 'Registry Only', icon: null })]);

    const entries = await buildLauncherEntries();

    expect(entries.find((e) => e.name === 'registry-only-app')?.icon).toBe('🧩');
  });

  it('uses services.ts only as presentation hints (grouping, visibility, description) for a registry app that has one', async () => {
    mocks.resolveLauncherApps.mockResolvedValue([navApp({ slug: 'coffee', name: 'Coffee', icon: '☕' })]);

    const coffee = (await buildLauncherEntries()).find((e) => e.name === 'coffee');

    expect(coffee).toMatchObject({ source: 'registry', category: 'creator', visibility: 'creator', icon: '☕' });
  });

  it('keeps kernel-native and project tiles from services.ts, marked static', async () => {
    const entries = await buildLauncherEntries();
    const statics = entries.filter((e) => e.source === 'static');

    expect(statics.length).toBeGreaterThan(0);
    expect(statics.every((e) => e.category === 'kernel' || e.category === 'meta')).toBe(true);
    expect(statics.map((e) => e.name)).toEqual(expect.arrayContaining(['auth', 'pay', 'github']));
    expect(entries.find((e) => e.name === 'github')?.externalUrl).toBeDefined();
  });

  it('does NOT list extractable apps from services.ts when the registry has no row for them (registry decides)', async () => {
    mocks.resolveLauncherApps.mockResolvedValue([]);

    const names = (await buildLauncherEntries()).map((e) => e.name);

    for (const slug of ['events', 'market', 'coffee', 'dykil', 'links', 'learn']) {
      expect(names).not.toContain(slug);
    }
  });
});
