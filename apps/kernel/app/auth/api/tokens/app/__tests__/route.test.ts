/**
 * Tests for POST /auth/api/tokens/app (#1069 Phase 1).
 *
 * This mint endpoint is the first-party counterpart to
 * /auth/api/apps/token: instead of an app DID + attestation, the caller
 * authenticates with their own session cookie and asks for a token scoped
 * to a specific app host (`aud`).
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

const mocks = vi.hoisted(() => ({
  verifySessionTokenMock: vi.fn(),
  createSessionAppTokenMock: vi.fn().mockResolvedValue('signed.session-app.jwt'),
  resolveActiveAppByAudienceMock: vi.fn(),
  resolveTokenAudiencesMock: vi.fn(),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
  getSessionCookieOptions: () => ({ name: 'imajin_session_dev', options: {} }),
}));
// Stand-in for the platform vocabulary (profile:read, connections:read, media:*) plus the app's
// own `providesScopes` — the real clamp is covered by packages/auth/tests/app-scopes.test.ts.
vi.mock('@imajin/auth', () => ({
  resolveAppScopes: (scopes: string[], provides: string[] = []) => {
    const known = new Set(['profile:read', 'connections:read', 'media:read', 'media:write', ...provides]);
    return { valid: scopes.filter((s) => known.has(s)), invalid: scopes.filter((s) => !known.has(s)) };
  },
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: mocks.verifySessionTokenMock,
  createSessionAppToken: mocks.createSessionAppTokenMock,
}));
vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: mocks.resolveActiveAppByAudienceMock,
  resolveTokenAudiences: mocks.resolveTokenAudiencesMock,
  appNotRegisteredResponse: () =>
    new Response(JSON.stringify({ error: 'app_not_registered', error_description: 'not registered' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

const USER_DID = 'did:imajin:user-abc';

function makeRequest(body: Record<string, unknown> | undefined, cookieValue?: string): Request {
  const req = new Request('https://kernel.test/auth/api/tokens/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Emulate NextRequest's `.cookies.get(name)` surface used by the route.
  (req as unknown as { cookies: { get: (name: string) => { value: string } | undefined } }).cookies = {
    get: (name: string) => (name === 'imajin_session_dev' && cookieValue ? { value: cookieValue } : undefined),
  };
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSessionAppTokenMock.mockResolvedValue('signed.session-app.jwt');
  // Default every test to an aud that IS registered — #1990 enforcement
  // tests below override this to exercise the unregistered path.
  mocks.resolveActiveAppByAudienceMock.mockResolvedValue({ id: 'app_first_party_coffee', appDid: 'did:imajin:app-coffee', ownerDid: 'did:imajin:platform', tier: 'first_party', status: 'active', providesScopes: [], dependsOn: [] });
  // Default: no dependency audiences — the token carries only the requested aud.
  mocks.resolveTokenAudiencesMock.mockImplementation(async (aud: string) => [aud]);
});

describe('POST /auth/api/tokens/app — requires a valid session (#1069 Phase 1)', () => {
  it('rejects with 401 when there is no session cookie', async () => {
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai' }) as never);

    expect(res.status).toBe(401);
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the session cookie does not verify', async () => {
    mocks.verifySessionTokenMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai' }, 'bad-token') as never);

    expect(res.status).toBe(401);
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/tokens/app — minting (#1069 Phase 1)', () => {
  beforeEach(() => {
    mocks.verifySessionTokenMock.mockResolvedValue({ sub: USER_DID });
  });

  it('rejects with 400 when aud is missing', async () => {
    const res = await POST(makeRequest({}, 'good-token') as never);

    expect(res.status).toBe(400);
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
  });

  it('mints a token scoped to the requested aud for the session did', async () => {
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai', scopes: ['profile:read'] }, 'good-token') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token).toBe('signed.session-app.jwt');
    expect(body.expiresIn).toBe(600);
    expect(body.scopes).toEqual(['profile:read']);
    expect(mocks.createSessionAppTokenMock).toHaveBeenCalledWith({
      sub: USER_DID,
      aud: ['coffee.imajin.ai'],
      scopes: ['profile:read'],
    });
  });

  it('clamps unknown scopes out of the vocabulary rather than minting them', async () => {
    const res = await POST(
      makeRequest({ aud: 'coffee.imajin.ai', scopes: ['profile:read', 'not-a-real-scope'] }, 'good-token') as never
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual(['profile:read']);
  });

  it('mints with an empty scope list when none are requested', async () => {
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai' }, 'good-token') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual([]);
  });
});

describe('POST /auth/api/tokens/app — refuses an unregistered audience (#1990)', () => {
  beforeEach(() => {
    mocks.verifySessionTokenMock.mockResolvedValue({ sub: USER_DID });
  });

  it('returns 403 app_not_registered when aud resolves to no active registry.apps row', async () => {
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ aud: 'evil.example.com' }, 'good-token') as never);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('app_not_registered');
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
    expect(mocks.resolveActiveAppByAudienceMock).toHaveBeenCalledWith('evil.example.com');
  });
});

describe('POST /auth/api/tokens/app — app-declared scopes (#2663 gap 1)', () => {
  const DYKIL_HOST = 'dykil.imajin.ai';
  const dykilApp = {
    id: 'app_dykil',
    appDid: 'did:imajin:app-dykil',
    ownerDid: 'did:imajin:platform',
    tier: 'third_party',
    status: 'active',
    providesScopes: ['dykil:read', 'dykil:write'],
    dependsOn: [],
  };

  beforeEach(() => {
    mocks.verifySessionTokenMock.mockResolvedValue({ sub: USER_DID });
  });

  it("grants the app's own providesScopes alongside vocabulary scopes", async () => {
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue(dykilApp);

    const res = await POST(
      makeRequest({ aud: DYKIL_HOST, scopes: ['dykil:read', 'dykil:write', 'profile:read'] }, 'good-token') as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual(['dykil:read', 'dykil:write', 'profile:read']);
  });

  it('still drops scopes the app did not declare', async () => {
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue(dykilApp);

    const res = await POST(
      makeRequest({ aud: DYKIL_HOST, scopes: ['dykil:read', 'dykil:admin', 'coffee:write'] }, 'good-token') as never,
    );
    const body = await res.json();

    expect(body.scopes).toEqual(['dykil:read']);
  });

  it("does not grant one app's scopes on another app's audience", async () => {
    // coffee's registry row declares nothing, so dykil:read is just an unknown scope there.
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai', scopes: ['dykil:read'] }, 'good-token') as never);
    const body = await res.json();

    expect(body.scopes).toEqual([]);
  });
});

describe('POST /auth/api/tokens/app — one token for the app and its dependencies (#2663 gap 2)', () => {
  const DYKIL_HOST = 'dykil.imajin.ai';
  const MEDIA_HOST = 'jin.imajin.ai';
  const dependsOn = [{ aud: MEDIA_HOST, scopes: ['media:read', 'media:write'] }];

  beforeEach(() => {
    mocks.verifySessionTokenMock.mockResolvedValue({ sub: USER_DID });
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue({
      id: 'app_dykil',
      appDid: 'did:imajin:app-dykil',
      ownerDid: 'did:imajin:platform',
      tier: 'third_party',
      status: 'active',
      providesScopes: ['dykil:read'],
      dependsOn,
    });
  });

  it('mints with every audience resolveTokenAudiences returns, primary first, and reports them', async () => {
    mocks.resolveTokenAudiencesMock.mockResolvedValue([DYKIL_HOST, MEDIA_HOST]);

    const res = await POST(
      makeRequest({ aud: DYKIL_HOST, scopes: ['dykil:read', 'media:read'] }, 'good-token') as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.aud).toEqual([DYKIL_HOST, MEDIA_HOST]);
    expect(mocks.createSessionAppTokenMock).toHaveBeenCalledWith({
      sub: USER_DID,
      aud: [DYKIL_HOST, MEDIA_HOST],
      scopes: ['dykil:read', 'media:read'],
    });
  });

  it('computes audiences from the registered app and the scopes actually granted', async () => {
    await POST(makeRequest({ aud: DYKIL_HOST, scopes: ['dykil:read', 'media:read', 'not-a-scope'] }, 'good-token') as never);

    expect(mocks.resolveTokenAudiencesMock).toHaveBeenCalledWith(
      DYKIL_HOST,
      expect.objectContaining({ dependsOn }),
      ['dykil:read', 'media:read'],
    );
  });
});
