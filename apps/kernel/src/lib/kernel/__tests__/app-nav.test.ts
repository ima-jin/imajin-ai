/**
 * Tests for apps/kernel/src/lib/kernel/app-nav.ts (#2425).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const identities = { id: 'identities.id', scope: 'identities.scope' };
  const forestConfig = { groupDid: 'forestConfig.groupDid', enabledServices: 'forestConfig.enabledServices' };
  const registryApps = {
    slug: 'registryApps.slug',
    name: 'registryApps.name',
    icon: 'registryApps.icon',
    entryUrl: 'registryApps.entryUrl',
    placements: 'registryApps.placements',
    requiredScope: 'registryApps.requiredScope',
    tier: 'registryApps.tier',
    status: 'registryApps.status',
  };

  const state = {
    identityRows: [] as Array<{ scope: string }>,
    forestRows: [] as Array<{ enabledServices: string[] }>,
    registryRows: [] as Array<Record<string, unknown>>,
  };

  function limitedWhere(rows: () => unknown[]) {
    return { where: () => ({ limit: async () => rows() }) };
  }

  function fromTable(table: unknown) {
    if (table === identities) return limitedWhere(() => state.identityRows);
    if (table === forestConfig) return limitedWhere(() => state.forestRows);
    return Promise.resolve(state.registryRows);
  }

  const selectMock = vi.fn(() => ({ from: fromTable }));

  return { identities, forestConfig, registryApps, state, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  identities: mocks.identities,
  forestConfig: mocks.forestConfig,
  registryApps: mocks.registryApps,
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

import { resolveNavAppsForIdentity, filterByPlacement, type NavApp } from '../app-nav';

const COFFEE_ROW = {
  slug: 'coffee',
  name: 'Coffee',
  icon: '☕',
  entryUrl: '/coffee',
  placements: ['launcher', 'home', 'auth-submenu'],
  requiredScope: 'creator',
  tier: 'first_party',
  status: 'active',
};
const LEARN_ROW = {
  slug: 'learn',
  name: 'Learn',
  icon: '📚',
  entryUrl: '/learn',
  placements: ['launcher', 'home', 'auth-submenu'],
  requiredScope: null,
  tier: 'first_party',
  status: 'active',
};
const REVOKED_ROW = { ...LEARN_ROW, slug: 'revoked-app', status: 'revoked' };
const NO_PLACEMENT_ROW = { ...LEARN_ROW, slug: 'jin', placements: [] };
const NO_SLUG_ROW = { ...LEARN_ROW, slug: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.identityRows = [];
  mocks.state.forestRows = [];
  mocks.state.registryRows = [];
});

describe('resolveNavAppsForIdentity — actor scope (#2425)', () => {
  it('sees every nav-capable app regardless of enabledServices, matching the pre-existing fallback behavior', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug).sort()).toEqual(['coffee', 'learn']);
    // Actor scope never needs a forest_config lookup.
    expect(mocks.selectMock).toHaveBeenCalledTimes(2);
  });

  it('excludes inactive rows and rows with no declared placement or slug', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.registryRows = [COFFEE_ROW, REVOKED_ROW, NO_PLACEMENT_ROW, NO_SLUG_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
  });
});

describe('resolveNavAppsForIdentity — group/business scope (#2425)', () => {
  it('filters to the identity forest_config.enabled_services list', async () => {
    mocks.state.identityRows = [{ scope: 'business' }];
    mocks.state.forestRows = [{ enabledServices: ['learn'] }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:group-1');

    expect(apps.map((a) => a.slug)).toEqual(['learn']);
  });

  it('returns nothing when the identity has no forest_config row (unconfigured)', async () => {
    mocks.state.identityRows = [{ scope: 'community' }];
    mocks.state.forestRows = [];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:group-2');

    expect(apps).toEqual([]);
  });

  it('applies the requiredScope gate on top of enabledServices — a creator-only app stays hidden from a non-matching scope', async () => {
    mocks.state.identityRows = [{ scope: 'business' }];
    mocks.state.forestRows = [{ enabledServices: ['coffee', 'learn'] }];
    mocks.state.registryRows = [{ ...COFFEE_ROW, requiredScope: 'creator' }, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:group-3');

    // 'business' scope does not match requiredScope 'creator' — coffee is filtered out.
    expect(apps.map((a) => a.slug)).toEqual(['learn']);
  });

  it('shows a requiredScope app when the identity scope matches exactly', async () => {
    mocks.state.identityRows = [{ scope: 'creator' }];
    mocks.state.forestRows = [{ enabledServices: ['coffee'] }];
    mocks.state.registryRows = [{ ...COFFEE_ROW, requiredScope: 'creator' }];

    const apps = await resolveNavAppsForIdentity('did:imajin:group-4');

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
  });
});

describe('filterByPlacement (#2425)', () => {
  it('narrows a resolved list down to apps declaring the given placement', () => {
    const apps: NavApp[] = [
      { ...COFFEE_ROW, placements: ['launcher', 'home', 'auth-submenu'] } as NavApp,
      { ...LEARN_ROW, placements: ['launcher'] } as NavApp,
    ];

    expect(filterByPlacement(apps, 'auth-submenu').map((a) => a.slug)).toEqual(['coffee']);
    expect(filterByPlacement(apps, 'launcher').map((a) => a.slug).sort()).toEqual(['coffee', 'learn']);
  });
});
