import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-owner-did.ts — DID resolution for connector routes (#1773) ────
//
// Before this fix, the app-auth branch resolved straight to the app owner's
// DID (`registry.apps.owner_did`), even when the app-auth context named a
// delegating human (`appAuth.userDid` / `X-Acting-For`). That is backwards
// from `resolveInferenceAuth` (`app/api/inference/capture/route.ts`) and
// `createConnectHandler` (`connector-oauth-routes.ts`), which both prefer the
// delegating user's own DID — a human's own card outranks the app's. The
// mismatch meant a Gemini key sealed under the owner's own DID while acting
// through an app was invisible to the model-list/seal routes, which kept
// checking the app owner's DID instead: a different row that had nothing
// sealed, surfaced as a misleading `gemini_no_key`.

const { requireAppAuthMock, requireAuthMock, resolveActingDidMock, lookupAppOwnerDidRows } = vi.hoisted(() => ({
  requireAppAuthMock: vi.fn(),
  requireAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
  ),
  lookupAppOwnerDidRows: { current: [] as Array<{ ownerDid: string }> },
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: requireAppAuthMock,
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => {
  const limit = () => Promise.resolve(lookupAppOwnerDidRows.current);
  const where = () => ({ limit });
  const from = () => ({ where });
  const select = () => ({ from });
  return {
    db: { select },
    registryApps: { appDid: 'appDid', ownerDid: 'ownerDid' },
  };
});

import { resolveConnectorOwnerDid } from '../connector-owner-did';

const APP_DID = 'did:imajin:agrifortress-app';
const APP_OWNER_DID = 'did:imajin:agrifortress-org';
const DELEGATING_USER_DID = 'did:imajin:ryan';
const SESSION_DID = 'did:imajin:session-user';

function makeRequest(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  requireAppAuthMock.mockReset();
  requireAuthMock.mockReset();
  resolveActingDidMock.mockClear();
  lookupAppOwnerDidRows.current = [{ ownerDid: APP_OWNER_DID }];

  requireAppAuthMock.mockResolvedValue({
    error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required',
    status: 401,
  });
  requireAuthMock.mockResolvedValue({ identity: { id: SESSION_DID } });
});

describe('resolveConnectorOwnerDid — session (no app-auth)', () => {
  it('resolves the session acting DID', async () => {
    const result = await resolveConnectorOwnerDid(makeRequest());

    expect(result).toEqual({ ok: true, ownerDid: SESSION_DID });
  });

  it('surfaces the session auth error when there is no app-auth hint', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await resolveConnectorOwnerDid(makeRequest());

    expect(result).toEqual({ ok: false, error: 'Not authenticated', status: 401 });
  });

  it('surfaces the app-auth error (not the session error) when app-auth headers were supplied but invalid', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'Invalid app token', status: 403 });
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await resolveConnectorOwnerDid(makeRequest({ 'x-app-did': APP_DID }));

    expect(result).toEqual({ ok: false, error: 'Invalid app token', status: 403 });
  });
});

describe('resolveConnectorOwnerDid — app-auth, owner-first precedence (#1773)', () => {
  it('prefers the delegating user DID (appAuth.userDid) over the app owner DID', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: DELEGATING_USER_DID, scopes: [], attestationId: 'att' },
    });

    const result = await resolveConnectorOwnerDid(makeRequest({ authorization: 'Bearer app-token' }));

    expect(result).toEqual({ ok: true, ownerDid: DELEGATING_USER_DID });
  });

  it('falls back to the legacy X-Acting-For header when appAuth.userDid is empty', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: '', scopes: [], attestationId: '', isServiceToken: true },
    });

    const result = await resolveConnectorOwnerDid(
      makeRequest({ authorization: 'Bearer service-token', 'x-acting-for': DELEGATING_USER_DID }),
    );

    expect(result).toEqual({ ok: true, ownerDid: DELEGATING_USER_DID });
  });

  it('falls back to the app owner DID for a pure service token with no delegating user', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: '', scopes: [], attestationId: '', isServiceToken: true },
    });

    const result = await resolveConnectorOwnerDid(makeRequest({ authorization: 'Bearer service-token' }));

    expect(result).toEqual({ ok: true, ownerDid: APP_OWNER_DID });
  });

  it('returns 404 when the app is unregistered and there is no delegating user', async () => {
    lookupAppOwnerDidRows.current = [];
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: '', scopes: [], attestationId: '', isServiceToken: true },
    });

    const result = await resolveConnectorOwnerDid(makeRequest({ authorization: 'Bearer service-token' }));

    expect(result).toEqual({
      ok: false,
      error: `App ${APP_DID} is not a registered app`,
      status: 404,
    });
  });

  it('never queries registry.apps when a delegating user DID is already available', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: APP_DID, userDid: DELEGATING_USER_DID, scopes: [], attestationId: 'att' },
    });
    lookupAppOwnerDidRows.current = [];

    const result = await resolveConnectorOwnerDid(makeRequest({ authorization: 'Bearer app-token' }));

    // If this had fallen through to the registry lookup, the empty rows array
    // seeded above would have produced a 404 instead of the delegating DID.
    expect(result).toEqual({ ok: true, ownerDid: DELEGATING_USER_DID });
  });
});
