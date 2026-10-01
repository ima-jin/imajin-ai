/**
 * Tests for apps/kernel/src/lib/kernel/app-nav.ts (#2425).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const identities = { id: 'identities.id', scope: 'identities.scope' };
  const forestConfig = { groupDid: 'forestConfig.groupDid', enabledServices: 'forestConfig.enabledServices' };
  const profiles = { did: 'profiles.did', featureToggles: 'profiles.featureToggles' };
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
    profileRows: [] as Array<{ featureToggles: Record<string, unknown> | null }>,
    /** Every table `db.select().from(...)` was called with, in order (#2434 — lets tests assert which lookups ran). */
    fromCalls: [] as unknown[],
    registryRows: [] as Array<Record<string, unknown>>,
  };

  function limitedWhere(rows: () => unknown[]) {
    return { where: () => ({ limit: async () => rows() }) };
  }

  // #2425 send-back: `isActiveRegistryAppSlug` chains `.where(...).limit(1)`
  // directly on the registryApps table (unlike `listNavCapableApps`, which
  // awaits the bare `.from()` result and filters in JS) — this interprets
  // the mocked `eq`/`and` shapes below against the raw row objects so both
  // call shapes work against the same `state.registryRows`.
  function matchesRegistryWhere(row: Record<string, unknown>, cond: unknown): boolean {
    const conds = (cond as { and?: unknown[] })?.and ?? [cond];
    return conds.every((c) => {
      const [colToken, val] = (c as { eq: [unknown, unknown] }).eq;
      const key = Object.entries(registryApps).find(([, v]) => v === colToken)?.[0];
      return key !== undefined && row[key] === val;
    });
  }

  function whereRegistryRows(cond: unknown): Record<string, unknown>[] {
    return state.registryRows.filter((row) => matchesRegistryWhere(row, cond));
  }

  function fromTable(table: unknown) {
    state.fromCalls.push(table);
    if (table === profiles) return limitedWhere(() => state.profileRows);
    if (table === identities) return limitedWhere(() => state.identityRows);
    if (table === forestConfig) return limitedWhere(() => state.forestRows);
    const bare: Promise<unknown[]> & { where?: (cond: unknown) => { limit: (n: number) => Promise<unknown[]> } } =
      Promise.resolve(state.registryRows);
    bare.where = (cond: unknown) => ({ limit: async (n: number) => whereRegistryRows(cond).slice(0, n) });
    return bare;
  }

  const selectMock = vi.fn(() => ({ from: fromTable }));

  return { identities, forestConfig, profiles, registryApps, state, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  identities: mocks.identities,
  forestConfig: mocks.forestConfig,
  profiles: mocks.profiles,
  registryApps: mocks.registryApps,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

import { resolveNavAppsForIdentity, filterByPlacement, resolveRegistryAppsBySlug, isActiveRegistryAppSlug, type NavApp } from '../app-nav';

// requiredScope is null (#2425 send-back): 'creator' is services.ts's
// display-visibility tier, not one of the four identity scopes, so the
// real coffee/dykil/links backfill never sets requiredScope to it — see
// 0167_registry_apps_nav_metadata.sql's header.
const COFFEE_ROW = {
  slug: 'coffee',
  name: 'Coffee',
  icon: '☕',
  entryUrl: '/coffee',
  placements: ['launcher', 'home', 'auth-submenu'],
  requiredScope: null,
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
  mocks.state.profileRows = [];
  mocks.state.fromCalls = [];
  mocks.state.registryRows = [];
});

describe('resolveNavAppsForIdentity — actor scope (#2425, #2434 ruling b)', () => {
  it('an actor that has never configured toggles (empty feature_toggles) sees every nav-capable app', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: {} }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug).sort()).toEqual(['coffee', 'learn']);
    // Actor scope reads the actor's own feature_toggles, never forest_config.
    expect(mocks.state.fromCalls).not.toContain(mocks.forestConfig);
    expect(mocks.state.fromCalls).toContain(mocks.profiles);
  });

  it('an actor with no profile row at all is also "never configured" and sees every app', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug).sort()).toEqual(['coffee', 'learn']);
  });

  it('an actor whose feature_toggles carry only unrelated keys has still never configured app toggles', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: { inference_enabled: true, show_events: true } }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug).sort()).toEqual(['coffee', 'learn']);
  });

  it('an actor with legacy toggles follows them — only the enabled app is visible', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: { coffee: 'ryan', learn: null, links: null } }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
  });

  it('an actor with enabledApps follows them', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: { enabledApps: ['learn'] } }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug)).toEqual(['learn']);
  });

  it('an actor who explicitly configured toggles with everything off sees no apps', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: { links: null, coffee: null, dykil: null, learn: null } }];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    await expect(resolveNavAppsForIdentity('did:imajin:actor-1')).resolves.toEqual([]);
  });

  it('an explicit empty enabledApps list means "none", not "never configured"', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: { enabledApps: [] } }];
    mocks.state.registryRows = [COFFEE_ROW];

    await expect(resolveNavAppsForIdentity('did:imajin:actor-1')).resolves.toEqual([]);
  });

  it('an identity with no resolvable scope keeps the pre-existing "sees everything" fallback without reading toggles', async () => {
    mocks.state.identityRows = [];
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:unknown');

    expect(apps.map((a) => a.slug).sort()).toEqual(['coffee', 'learn']);
    expect(mocks.state.fromCalls).not.toContain(mocks.profiles);
  });

  it('excludes inactive rows and rows with no declared placement or slug', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.registryRows = [COFFEE_ROW, REVOKED_ROW, NO_PLACEMENT_ROW, NO_SLUG_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:actor-1');

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
  });

  it('still applies the requiredScope gate on top of the actor\'s toggles (actor scope passes any requiredScope)', async () => {
    mocks.state.identityRows = [{ scope: 'actor' }];
    mocks.state.profileRows = [{ featureToggles: { coffee: 'ryan' } }];
    mocks.state.registryRows = [{ ...COFFEE_ROW, requiredScope: 'business' }];

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

  it('applies the requiredScope gate on top of enabledServices — an app scoped to a different identity scope stays hidden', async () => {
    mocks.state.identityRows = [{ scope: 'business' }];
    mocks.state.forestRows = [{ enabledServices: ['coffee', 'learn'] }];
    // requiredScope here is a real identity scope value ('family'), unlike
    // the pre-fix bug that compared against services.ts's display tier.
    mocks.state.registryRows = [{ ...COFFEE_ROW, requiredScope: 'family' }, LEARN_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:group-3');

    // 'business' scope does not match requiredScope 'family' — coffee is filtered out.
    expect(apps.map((a) => a.slug)).toEqual(['learn']);
  });

  it('shows a requiredScope app when the identity scope matches exactly', async () => {
    mocks.state.identityRows = [{ scope: 'family' }];
    mocks.state.forestRows = [{ enabledServices: ['coffee'] }];
    mocks.state.registryRows = [{ ...COFFEE_ROW, requiredScope: 'family' }];

    const apps = await resolveNavAppsForIdentity('did:imajin:group-4');

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
  });

  it('#2425 send-back: a business identity with coffee enabled sees coffee (requiredScope NULL never hides it from a non-actor scope)', async () => {
    mocks.state.identityRows = [{ scope: 'business' }];
    mocks.state.forestRows = [{ enabledServices: ['coffee'] }];
    mocks.state.registryRows = [COFFEE_ROW];

    const apps = await resolveNavAppsForIdentity('did:imajin:business-1');

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

describe('resolveRegistryAppsBySlug (#2425 send-back — public, unauthenticated profile reads)', () => {
  it('returns an empty array without querying the db when given no slugs', async () => {
    const apps = await resolveRegistryAppsBySlug([]);

    expect(apps).toEqual([]);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns only the registry apps matching the given slugs, ignoring identity/scope entirely', async () => {
    mocks.state.registryRows = [COFFEE_ROW, LEARN_ROW];

    const apps = await resolveRegistryAppsBySlug(['coffee']);

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
    // No identity or forest_config lookup — only the registry itself.
    expect(mocks.selectMock).toHaveBeenCalledTimes(1);
  });

  it('excludes inactive/no-placement/no-slug rows, same as the nav-capable filter', async () => {
    mocks.state.registryRows = [COFFEE_ROW, REVOKED_ROW, NO_PLACEMENT_ROW, NO_SLUG_ROW];

    const apps = await resolveRegistryAppsBySlug(['coffee', 'revoked-app', 'jin']);

    expect(apps.map((a) => a.slug)).toEqual(['coffee']);
  });
});

describe('isActiveRegistryAppSlug (#2425 send-back — health route slug validation)', () => {
  it('returns true for a slug with an active registry.apps row', async () => {
    mocks.state.registryRows = [COFFEE_ROW];

    await expect(isActiveRegistryAppSlug('coffee')).resolves.toBe(true);
  });

  it('returns false for a slug with no registry.apps row at all', async () => {
    mocks.state.registryRows = [COFFEE_ROW];

    await expect(isActiveRegistryAppSlug('not-a-real-app')).resolves.toBe(false);
  });

  it('returns false for a slug whose only row is not active (e.g. revoked)', async () => {
    mocks.state.registryRows = [REVOKED_ROW];

    await expect(isActiveRegistryAppSlug('revoked-app')).resolves.toBe(false);
  });

  it('is not placement-gated — a row with no declared placements still counts as a valid, reachable slug', async () => {
    mocks.state.registryRows = [NO_PLACEMENT_ROW];

    await expect(isActiveRegistryAppSlug('jin')).resolves.toBe(true);
  });
});
