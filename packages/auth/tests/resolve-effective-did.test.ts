/**
 * Tests for `resolveEffectiveDid` (#1812).
 *
 * `requireAppAuth` treats `Authorization: Bearer <app-token>` as the
 * preferred app-auth path (#1069), but `resolveEffectiveDid` used to only
 * attempt app auth when the legacy `X-App-DID` header was present. A
 * bearer-only external app therefore fell straight through to session auth
 * and got a generic 401 even with a perfectly valid, correctly-scoped app
 * token.
 *
 * The fix: try app-token verification first whenever a bearer or the legacy
 * headers are present. Only a bearer that doesn't verify as an app token at
 * all (`notAppToken`) falls through to session auth — session JWTs are also
 * sent as `Authorization: Bearer`, so that's the discriminator, not "a
 * bearer exists" or "requireAppAuth returned an error".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAppAuth, mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockRequireAuth: vi.fn(),
}));

vi.mock('../src/require-app-auth', () => ({ requireAppAuth: mockRequireAppAuth }));
vi.mock('../src/require-auth', () => ({ requireAuth: mockRequireAuth }));

import { resolveEffectiveDid } from '../src/resolve-effective-did';
import type { Scope } from '../src/scopes';

const SCOPE: Scope = 'connections:read';
const APP_DID = 'did:imajin:agrifortress-webhook';
const APP_USER_DID = 'did:imajin:agrifortress-recipient';
const SESSION_DID = 'did:imajin:session-user';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://kernel.test/connections/api/connections', { headers });
}

function appAuthSuccess(userDid = APP_USER_DID) {
  return {
    appAuth: { appDid: APP_DID, userDid, scopes: [SCOPE], attestationId: 'att_1' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveEffectiveDid — bearer-only app token (#1812)', () => {
  it('AgriFortress shape: a bearer app token with the granted scope resolves the app branch without any legacy header', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuthSuccess());

    const result = await resolveEffectiveDid(makeRequest({ authorization: 'Bearer app-token' }), { scope: SCOPE });

    expect(result).toEqual({ ok: true, effectiveDid: APP_USER_DID, via: 'app', composedBy: null });
    expect(mockRequireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: SCOPE });
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('a bearer app token missing the required scope is rejected with the authoritative 403, not a generic 401', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: "Scope 'connections:read' was not granted", status: 403 });

    const result = await resolveEffectiveDid(makeRequest({ authorization: 'Bearer app-token' }), { scope: SCOPE });

    expect(result).toEqual({ ok: false, status: 403, error: "Scope 'connections:read' was not granted" });
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('a bearer that does not verify as an app token falls through to session auth', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid or expired app token', status: 401, notAppToken: true });
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: SESSION_DID, scope: 'actor' } });

    const result = await resolveEffectiveDid(makeRequest({ authorization: 'Bearer session-jwt' }), { scope: SCOPE });

    expect(result).toEqual({ ok: true, effectiveDid: SESSION_DID, via: 'session', composedBy: null });
    expect(mockRequireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: SCOPE });
    expect(mockRequireAuth).toHaveBeenCalled();
  });

  it('a non-app-token bearer that also fails session auth still resolves to a generic 401', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid or expired app token', status: 401, notAppToken: true });
    mockRequireAuth.mockResolvedValueOnce({ error: 'Invalid or expired token', status: 401 });

    const result = await resolveEffectiveDid(makeRequest({ authorization: 'Bearer garbage' }), { scope: SCOPE });

    expect(result).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });
});

describe('resolveEffectiveDid — legacy X-App-DID + X-App-Authorization path (unchanged)', () => {
  it('resolves the app branch when the legacy headers verify', async () => {
    mockRequireAppAuth.mockResolvedValueOnce(appAuthSuccess());

    const result = await resolveEffectiveDid(
      makeRequest({ 'x-app-did': APP_DID, 'x-app-authorization': 'att_1' }),
      { scope: SCOPE },
    );

    expect(result).toEqual({ ok: true, effectiveDid: APP_USER_DID, via: 'app', composedBy: null });
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('surfaces the legacy path error directly, never falling through to session auth', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid app authorization', status: 401 });

    const result = await resolveEffectiveDid(
      makeRequest({ 'x-app-did': APP_DID, 'x-app-authorization': 'bad' }),
      { scope: SCOPE },
    );

    expect(result).toEqual({ ok: false, status: 401, error: 'Invalid app authorization' });
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });
});

describe('resolveEffectiveDid — kernel web-session auth (unchanged)', () => {
  it('skips app auth entirely when no bearer or legacy app headers are present', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: SESSION_DID, scope: 'actor' } });

    const result = await resolveEffectiveDid(makeRequest({ cookie: 'imajin_session=abc' }), { scope: SCOPE });

    expect(result).toEqual({ ok: true, effectiveDid: SESSION_DID, via: 'session', composedBy: null });
    expect(mockRequireAppAuth).not.toHaveBeenCalled();
  });

  it('returns a generic 401 when session auth fails outright', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const result = await resolveEffectiveDid(makeRequest(), { scope: SCOPE });

    expect(result).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });
});
