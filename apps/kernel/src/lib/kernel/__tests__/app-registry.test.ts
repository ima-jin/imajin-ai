/**
 * Tests for apps/kernel/src/lib/kernel/app-registry.ts (#1990).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const limitMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  whereMock.mockImplementation(() => ({ limit: limitMock }));
  return { whereMock, limitMock, fromMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  registryApps: {
    id: 'registryApps.id',
    appDid: 'registryApps.appDid',
    ownerDid: 'registryApps.ownerDid',
    tier: 'registryApps.tier',
    status: 'registryApps.status',
    tokenAudiences: 'registryApps.tokenAudiences',
    slug: 'registryApps.slug',
    requestedScopes: 'registryApps.requestedScopes',
    providesScopes: 'registryApps.providesScopes',
    dependsOn: 'registryApps.dependsOn',
  },
}));

vi.mock('drizzle-orm', () => ({
  arrayContains: (...args: unknown[]) => ({ arrayContains: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({ 'X-Test': '1' }) }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
  resolveActiveAppByAudience,
  resolveTokenGrant,
  isAppDidActive,
  appNotRegisteredResponse,
  APP_NOT_REGISTERED_ERROR,
} from '../app-registry';

const ACTIVE_ROW = {
  id: 'app_first_party_coffee',
  appDid: 'did:imajin:app-coffee',
  ownerDid: 'did:imajin:platform',
  tier: 'first_party',
  status: 'active',
  slug: null as string | null,
  requestedScopes: [] as string[],
  providesScopes: [] as string[],
  dependsOn: [] as Array<{ aud: string; scopes: string[] }>,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockImplementation(() => ({ limit: mocks.limitMock }));
});

describe('resolveActiveAppByAudience (#1990)', () => {
  it('returns null for an empty/undefined aud without querying the db', async () => {
    expect(await resolveActiveAppByAudience(undefined)).toBeNull();
    expect(await resolveActiveAppByAudience('')).toBeNull();
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns the row when an active app registered this audience', async () => {
    mocks.limitMock.mockResolvedValue([ACTIVE_ROW]);

    const result = await resolveActiveAppByAudience('coffee');

    expect(result).toEqual(ACTIVE_ROW);
  });

  it("returns the app's declared providesScopes and dependsOn (#2663)", async () => {
    const dependsOn = [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }];
    mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, slug: 'dykil', providesScopes: ['dykil:read'], dependsOn }]);

    const result = await resolveActiveAppByAudience('dykil');

    expect(result?.providesScopes).toEqual(['dykil:read']);
    expect(result?.dependsOn).toEqual(dependsOn);
  });

  it('normalises null declarations from a pre-0176 row to empty arrays (#2663)', async () => {
    mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, providesScopes: null, dependsOn: null, requestedScopes: null }]);

    const result = await resolveActiveAppByAudience('coffee');

    expect(result?.providesScopes).toEqual([]);
    expect(result?.dependsOn).toEqual([]);
    expect(result?.requestedScopes).toEqual([]);
  });

  it('returns the slug and requestedScopes the mint ceiling is computed from (#2674)', async () => {
    mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, slug: 'dykil', requestedScopes: ['dykil:read', 'media:read'] }]);

    const result = await resolveActiveAppByAudience('dykil');

    expect(result?.slug).toBe('dykil');
    expect(result?.requestedScopes).toEqual(['dykil:read', 'media:read']);
  });

  describe('providesScopes are honoured only in the row\'s own slug namespace (#2674)', () => {
    it('drops a slug-less row\'s providesScopes — a legacy squatted dykil:read grants nothing', async () => {
      mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, slug: null, providesScopes: ['dykil:read', 'dykil:write'] }]);

      const result = await resolveActiveAppByAudience('squatter');

      expect(result?.providesScopes).toEqual([]);
    });

    it('drops scopes in another app\'s namespace from a slugged row, keeping its own', async () => {
      mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, slug: 'links', providesScopes: ['links:read', 'dykil:read'] }]);

      const result = await resolveActiveAppByAudience('links');

      expect(result?.providesScopes).toEqual(['links:read']);
    });
  });

  it('returns null when no row matches the audience', async () => {
    mocks.limitMock.mockResolvedValue([]);

    expect(await resolveActiveAppByAudience('unknown-aud')).toBeNull();
  });

  it('returns null when the matching row has been revoked', async () => {
    mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, status: 'revoked' }]);

    expect(await resolveActiveAppByAudience('coffee')).toBeNull();
  });

  it('fails closed (returns null) when the lookup throws', async () => {
    mocks.limitMock.mockRejectedValue(new Error('db down'));

    expect(await resolveActiveAppByAudience('coffee')).toBeNull();
  });
});

describe('isAppDidActive (#1990)', () => {
  it('returns false for an empty/undefined appDid without querying the db', async () => {
    expect(await isAppDidActive(undefined)).toBe(false);
    expect(await isAppDidActive('')).toBe(false);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns true when the app is active', async () => {
    mocks.limitMock.mockResolvedValue([{ status: 'active' }]);

    expect(await isAppDidActive('did:imajin:app-coffee')).toBe(true);
  });

  it('returns false when the app has been revoked', async () => {
    mocks.limitMock.mockResolvedValue([{ status: 'revoked' }]);

    expect(await isAppDidActive('did:imajin:app-coffee')).toBe(false);
  });

  it('returns false when no row exists for the appDid', async () => {
    mocks.limitMock.mockResolvedValue([]);

    expect(await isAppDidActive('did:imajin:unknown')).toBe(false);
  });

  it('fails closed (returns false) when the lookup throws', async () => {
    mocks.limitMock.mockRejectedValue(new Error('db down'));

    expect(await isAppDidActive('did:imajin:app-coffee')).toBe(false);
  });
});

describe('appNotRegisteredResponse (#1990)', () => {
  it('returns a 403 with the stable app_not_registered body', async () => {
    const res = appNotRegisteredResponse(new Request('https://kernel.test/x') as never);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual(APP_NOT_REGISTERED_ERROR);
  });
});

describe('resolveTokenGrant (#2663)', () => {
  const MEDIA = 'jin.imajin.ai';
  const OTHER = 'events.imajin.ai';
  // The ceiling covers providesScopes + approved dependency scopes, so these fixtures
  // leave `requestedScopes` empty; the ceiling itself is covered in its own block below.
  const app = {
    tier: 'third_party',
    requestedScopes: [] as string[],
    providesScopes: ['dykil:read', 'dykil:write'],
    dependsOn: [
      { aud: MEDIA, scopes: ['media:read', 'media:write'] },
      { aud: OTHER, scopes: ['events:read'] },
    ],
  };

  /** Make `resolveActiveAppByAudience` find an active row only for the given audiences. */
  function registered(...auds: string[]): void {
    let current = '';
    mocks.whereMock.mockImplementation((cond: { arrayContains: unknown[] }) => {
      current = (cond.arrayContains[1] as string[])[0];
      return { limit: mocks.limitMock };
    });
    mocks.limitMock.mockImplementation(async () => (auds.includes(current) ? [ACTIVE_ROW] : []));
  }

  describe('audiences', () => {
    it('returns just the primary audience when the app declares no dependencies', async () => {
      const grant = await resolveTokenGrant(
        'dykil.imajin.ai',
        { tier: 'third_party', requestedScopes: ['dykil:read'], providesScopes: [], dependsOn: [] },
        ['dykil:read'],
      );

      expect(grant).toEqual({ audiences: ['dykil.imajin.ai'], scopes: ['dykil:read'] });
      expect(mocks.selectMock).not.toHaveBeenCalled();
    });

    it('adds a dependency audience when a requested scope reaches it and it is still registered', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['dykil:read', 'media:read']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai', MEDIA]);
    });

    it('adds every reached dependency, in declaration order', async () => {
      registered(MEDIA, OTHER);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['events:read', 'media:write']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai', MEDIA, OTHER]);
    });

    it('leaves out a dependency no requested scope reaches (least privilege)', async () => {
      registered(MEDIA, OTHER);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['dykil:read']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai']);
      expect(mocks.selectMock).not.toHaveBeenCalled();
    });

    it('drops a dependency that is no longer registered or active rather than failing the mint', async () => {
      registered(OTHER);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['media:read', 'events:read']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai', OTHER]);
    });

    it('never duplicates the primary audience', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant(
        MEDIA,
        { tier: 'third_party', requestedScopes: [], providesScopes: [], dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }] },
        ['media:read'],
      );

      expect(grant.audiences).toEqual([MEDIA]);
    });
  });

  describe('scopes: exactly what the operator approved', () => {
    const readOnlyMedia = {
      tier: 'third_party',
      requestedScopes: ['profile:read'],
      providesScopes: ['dykil:read'],
      dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }],
    };

    it('does not let a token reach media:write when only media:read was declared', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', readOnlyMedia, ['media:read', 'media:write']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai', MEDIA]);
      expect(grant.scopes).toEqual(['media:read']);
      expect(grant.scopes).not.toContain('media:write');
    });

    it('keeps the app\'s own providesScopes next to the approved dependency scopes', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', readOnlyMedia, ['dykil:read', 'media:read', 'media:write']);

      expect(grant.scopes).toEqual(['dykil:read', 'media:read']);
    });

    it('drops every other platform scope once the token carries a dependency audience', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', readOnlyMedia, [
        'profile:read',
        'wallet:write',
        'media:read',
        'messages:write',
      ]);

      expect(grant.scopes).toEqual(['media:read']);
    });

    it('keeps the full declared list when the app declared it all', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['dykil:write', 'media:read', 'media:write']);

      expect(grant.scopes).toEqual(['dykil:write', 'media:read', 'media:write']);
    });

    it('unions the approved scopes of every dependency actually added', async () => {
      registered(MEDIA, OTHER);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['media:write', 'events:read', 'events:write']);

      expect(grant.scopes).toEqual(['media:write', 'events:read']);
    });

    it('does not keep a dependency\'s scopes when that dependency was not added (unregistered)', async () => {
      registered(OTHER);

      const grant = await resolveTokenGrant('dykil.imajin.ai', app, ['media:read', 'events:read']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai', OTHER]);
      expect(grant.scopes).toEqual(['events:read']);
    });

    it('clamps to nothing foreign when every reached dependency has been dropped', async () => {
      registered();

      const grant = await resolveTokenGrant('dykil.imajin.ai', readOnlyMedia, ['dykil:read', 'media:read', 'profile:read']);

      // No dependency audience: the token is only valid at the app's own host, so it is left as requested.
      expect(grant).toEqual({ audiences: ['dykil.imajin.ai'], scopes: ['dykil:read', 'media:read', 'profile:read'] });
    });

    it('leaves a token with no dependency audience exactly as requested', async () => {
      const grant = await resolveTokenGrant('dykil.imajin.ai', readOnlyMedia, ['dykil:read', 'profile:read']);

      expect(grant.scopes).toEqual(['dykil:read', 'profile:read']);
    });
  });

  describe('requested_scopes is the ceiling at mint (#2674)', () => {
    const third = (requestedScopes: string[], extra: Partial<typeof app> = {}) => ({
      tier: 'third_party',
      requestedScopes,
      providesScopes: [] as string[],
      dependsOn: [] as Array<{ aud: string; scopes: string[] }>,
      ...extra,
    });

    it('never mints a scope the app was not assigned, even when it is in the platform vocabulary', async () => {
      const grant = await resolveTokenGrant('coffee', third(['profile:read']), ['profile:read', 'wallet:write', 'media:write']);

      expect(grant.scopes).toEqual(['profile:read']);
    });

    it('mints nothing for a third-party app with nothing assigned (empty list is not "unconstrained")', async () => {
      const grant = await resolveTokenGrant('coffee', third([]), ['profile:read', 'media:read']);

      expect(grant).toEqual({ audiences: ['coffee'], scopes: [] });
    });

    it('counts the approved dependsOn scopes inside the ceiling even when requestedScopes is empty (pre-#2674 provisioned rows)', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', third([], { dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }] }), ['media:read']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai', MEDIA]);
      expect(grant.scopes).toEqual(['media:read']);
    });

    it('does not let a dependency be reached with a scope outside both requestedScopes and the approved dependsOn', async () => {
      registered(MEDIA);

      const grant = await resolveTokenGrant('dykil.imajin.ai', third(['dykil:read'], { dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }] }), ['media:write']);

      expect(grant.audiences).toEqual(['dykil.imajin.ai']);
      expect(grant.scopes).toEqual([]);
    });

    it('counts the app\'s own providesScopes inside the ceiling', async () => {
      const grant = await resolveTokenGrant('dykil.imajin.ai', third([], { providesScopes: ['dykil:read'] }), ['dykil:read', 'dykil:write']);

      expect(grant.scopes).toEqual(['dykil:read']);
    });

    it('leaves a legacy first_party row with nothing assigned (the 0139 seed) unconstrained', async () => {
      const legacy = { tier: 'first_party', requestedScopes: [] as string[], providesScopes: [] as string[], dependsOn: [] };

      const grant = await resolveTokenGrant('coffee', legacy, ['profile:read', 'media:write']);

      expect(grant.scopes).toEqual(['profile:read', 'media:write']);
    });

    it('holds a first_party row that does have an assignment to it', async () => {
      const assigned = { tier: 'first_party', requestedScopes: ['profile:read'], providesScopes: [] as string[], dependsOn: [] };

      const grant = await resolveTokenGrant('coffee', assigned, ['profile:read', 'media:write']);

      expect(grant.scopes).toEqual(['profile:read']);
    });
  });
});
