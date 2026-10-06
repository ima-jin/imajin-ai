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
  resolveTokenAudiences,
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
    mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, providesScopes: ['dykil:read'], dependsOn }]);

    const result = await resolveActiveAppByAudience('dykil');

    expect(result?.providesScopes).toEqual(['dykil:read']);
    expect(result?.dependsOn).toEqual(dependsOn);
  });

  it('normalises null declarations from a pre-0176 row to empty arrays (#2663)', async () => {
    mocks.limitMock.mockResolvedValue([{ ...ACTIVE_ROW, providesScopes: null, dependsOn: null }]);

    const result = await resolveActiveAppByAudience('coffee');

    expect(result?.providesScopes).toEqual([]);
    expect(result?.dependsOn).toEqual([]);
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

describe('resolveTokenAudiences (#2663)', () => {
  const MEDIA = 'jin.imajin.ai';
  const OTHER = 'events.imajin.ai';
  const app = {
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

  it('returns just the primary audience when the app declares no dependencies', async () => {
    expect(await resolveTokenAudiences('dykil.imajin.ai', { dependsOn: [] }, ['dykil:read'])).toEqual(['dykil.imajin.ai']);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('adds a dependency audience when a granted scope reaches it and it is still registered', async () => {
    registered(MEDIA);

    expect(await resolveTokenAudiences('dykil.imajin.ai', app, ['dykil:read', 'media:read'])).toEqual(['dykil.imajin.ai', MEDIA]);
  });

  it('adds every reached dependency, in declaration order', async () => {
    registered(MEDIA, OTHER);

    expect(await resolveTokenAudiences('dykil.imajin.ai', app, ['events:read', 'media:write'])).toEqual(['dykil.imajin.ai', MEDIA, OTHER]);
  });

  it('leaves out a dependency no granted scope reaches (least privilege)', async () => {
    registered(MEDIA, OTHER);

    expect(await resolveTokenAudiences('dykil.imajin.ai', app, ['dykil:read'])).toEqual(['dykil.imajin.ai']);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('drops a dependency that is no longer registered or active rather than failing the mint', async () => {
    registered(OTHER);

    expect(await resolveTokenAudiences('dykil.imajin.ai', app, ['media:read', 'events:read'])).toEqual(['dykil.imajin.ai', OTHER]);
  });

  it('never duplicates the primary audience', async () => {
    registered(MEDIA);

    expect(
      await resolveTokenAudiences(MEDIA, { dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }] }, ['media:read']),
    ).toEqual([MEDIA]);
  });
});
