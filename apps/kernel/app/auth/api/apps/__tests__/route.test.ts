import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  resolveNavAppsForIdentity: vi.fn(),
  APP_PLACEMENTS: ['launcher', 'home', 'auth-submenu'] as const,
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { actingFor?: string; id: string }) => identity.actingFor ?? identity.id,
}));

vi.mock('@/src/lib/kernel/app-nav', () => ({
  APP_PLACEMENTS: mocks.APP_PLACEMENTS,
  resolveNavAppsForIdentity: mocks.resolveNavAppsForIdentity,
  filterByPlacement: (apps: Array<{ placements: string[] }>, placement: string) =>
    apps.filter((app) => app.placements.includes(placement)),
}));

import { GET } from '../route';

const OWNER_DID = 'did:imajin:owner';
const AGENT_DID = 'did:imajin:agent';

const COFFEE_APP = {
  slug: 'coffee',
  name: 'Coffee',
  icon: '☕',
  entryUrl: '/coffee',
  placements: ['launcher', 'home', 'auth-submenu'],
  requiredScope: 'creator',
  tier: 'first_party',
};
const LEARN_APP = {
  slug: 'learn',
  name: 'Learn',
  icon: '📚',
  entryUrl: '/learn',
  placements: ['launcher'],
  requiredScope: null,
  tier: 'first_party',
};

function makeReq(url: string): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  mocks.resolveNavAppsForIdentity.mockResolvedValue([COFFEE_APP, LEARN_APP]);
});

describe('GET /auth/api/apps (#2425)', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq('https://kernel.test/auth/api/apps'));

    expect(res.status).toBe(401);
    expect(mocks.resolveNavAppsForIdentity).not.toHaveBeenCalled();
  });

  it("defaults 'for' to the caller's own effective DID", async () => {
    await GET(makeReq('https://kernel.test/auth/api/apps'));

    expect(mocks.resolveNavAppsForIdentity).toHaveBeenCalledWith(OWNER_DID);
  });

  it("allows a registered agent (actingFor) to read its principal's apps", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: AGENT_DID, actingFor: OWNER_DID } });

    const res = await GET(makeReq(`https://kernel.test/auth/api/apps?for=${OWNER_DID}`));

    expect(res.status).toBe(200);
    expect(mocks.resolveNavAppsForIdentity).toHaveBeenCalledWith(OWNER_DID);
  });

  it('returns 403 for a `for` DID that does not match the effective DID (scope: self-only)', async () => {
    const res = await GET(makeReq('https://kernel.test/auth/api/apps?for=did:imajin:someone-else'));

    expect(res.status).toBe(403);
    expect(mocks.resolveNavAppsForIdentity).not.toHaveBeenCalled();
  });

  it('returns the full enabled-for-identity app list with no placement filter', async () => {
    const res = await GET(makeReq('https://kernel.test/auth/api/apps'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps.map((a: { slug: string }) => a.slug)).toEqual(['coffee', 'learn']);
  });

  it('applies a placement filter when provided', async () => {
    const res = await GET(makeReq('https://kernel.test/auth/api/apps?placement=home'));

    const body = await res.json();
    // LEARN_APP only declares 'launcher' — filtered out of 'home'.
    expect(body.apps.map((a: { slug: string }) => a.slug)).toEqual(['coffee']);
  });

  it('rejects an invalid placement value', async () => {
    const res = await GET(makeReq('https://kernel.test/auth/api/apps?placement=not-a-placement'));

    expect(res.status).toBe(400);
    expect(mocks.resolveNavAppsForIdentity).not.toHaveBeenCalled();
  });

  it('sets a short, private cache header', async () => {
    const res = await GET(makeReq('https://kernel.test/auth/api/apps'));

    expect(res.headers.get('Cache-Control')).toBe('private, max-age=30');
  });
});
