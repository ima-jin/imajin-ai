/**
 * Tests for POST /auth/api/attestations/:id/revoke (#2649) — issuer-only
 * withdrawal of an attestation via `revokedAt`, callable with a session or a
 * session-scoped app token (#2394).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const ISSUER = 'did:imajin:alice';
const APP_DID = 'did:imajin:app-dykil';
const DELEGATOR = 'did:imajin:ryan';
const ATTESTATION_ID = 'att_to_revoke';

const h = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  verifySessionAppTokenLocal: vi.fn(),
  resolveActiveAppByAudience: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateReturning: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.mockSelectLimit }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.mockUpdateSet(values);
        return { where: () => ({ returning: h.mockUpdateReturning }) };
      },
    }),
  },
  attestations: {},
  tokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: h.verifySessionToken,
  verifySessionAppTokenLocal: h.verifySessionAppTokenLocal,
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: h.resolveActiveAppByAudience,
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

function sessionReq(): NextRequest {
  return {
    cookies: { get: () => ({ value: 'session-token' }) },
    headers: new Headers(),
  } as unknown as NextRequest;
}

function noCredentialsReq(): NextRequest {
  return { cookies: { get: () => undefined }, headers: new Headers() } as unknown as NextRequest;
}

function appTokenReq(token: string): NextRequest {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${token}`);
  return { cookies: { get: () => undefined }, headers } as unknown as NextRequest;
}

function ctx(id: string = ATTESTATION_ID) {
  return { params: Promise.resolve({ did: id }) };
}

function stored(overrides: Record<string, unknown> = {}) {
  return { id: ATTESTATION_ID, issuerDid: ISSUER, delegatorDid: null, revokedAt: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifySessionToken.mockResolvedValue({ sub: ISSUER });
  h.verifySessionAppTokenLocal.mockResolvedValue(null);
  h.resolveActiveAppByAudience.mockResolvedValue(null);
  h.mockSelectLimit.mockResolvedValue([stored()]);
  h.mockUpdateReturning.mockResolvedValue([{ id: ATTESTATION_ID, revokedAt: new Date('2026-10-06T00:00:00Z') }]);
});

describe('POST /auth/api/attestations/:id/revoke (#2649)', () => {
  it('lets the issuer revoke via session and stamps revokedAt', async () => {
    const res = await POST(sessionReq(), ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: ATTESTATION_ID, revokedAt: '2026-10-06T00:00:00.000Z' });
    expect(h.mockUpdateSet).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
  });

  it('returns 401 with no credentials and touches nothing', async () => {
    const res = await POST(noCredentialsReq(), ctx());

    expect(res.status).toBe(401);
    expect(h.mockSelectLimit).not.toHaveBeenCalled();
    expect(h.mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 404 when the attestation does not exist', async () => {
    h.mockSelectLimit.mockResolvedValue([]);

    const res = await POST(sessionReq(), ctx('att_missing'));

    expect(res.status).toBe(404);
    expect(h.mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not the issuer', async () => {
    h.verifySessionToken.mockResolvedValue({ sub: 'did:imajin:mallory' });

    const res = await POST(sessionReq(), ctx());

    expect(res.status).toBe(403);
    expect(h.mockUpdateSet).not.toHaveBeenCalled();
  });

  it('does not let the subject revoke an attestation they did not issue', async () => {
    h.mockSelectLimit.mockResolvedValue([stored({ issuerDid: 'did:imajin:carol' })]);
    h.verifySessionToken.mockResolvedValue({ sub: 'did:imajin:bob' });

    const res = await POST(sessionReq(), ctx());

    expect(res.status).toBe(403);
    expect(h.mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 409 when the attestation is already revoked', async () => {
    h.mockSelectLimit.mockResolvedValue([stored({ revokedAt: new Date() })]);

    const res = await POST(sessionReq(), ctx());

    expect(res.status).toBe(409);
    expect(h.mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 409 when a concurrent revoke wins the guarded update', async () => {
    h.mockUpdateReturning.mockResolvedValue([]);

    const res = await POST(sessionReq(), ctx());

    expect(res.status).toBe(409);
  });

  it('decodes a percent-encoded attestation id from the path', async () => {
    const res = await POST(sessionReq(), ctx(encodeURIComponent(ATTESTATION_ID)));

    expect(res.status).toBe(200);
  });
});

describe('POST /auth/api/attestations/:id/revoke — scoped app token (#2394)', () => {
  it('accepts a valid session-app-token whose sub is the issuer', async () => {
    h.verifySessionAppTokenLocal.mockResolvedValue({ sub: ISSUER, aud: 'dykil.example.com', scopes: [] });
    h.resolveActiveAppByAudience.mockResolvedValue({ id: 'app_dykil', appDid: APP_DID, status: 'active' });

    const res = await POST(appTokenReq('scoped-app-token'), ctx());

    expect(res.status).toBe(200);
    expect(h.resolveActiveAppByAudience).toHaveBeenCalledWith('dykil.example.com');
  });

  it('lets the delegator revoke an app-issued attestation through an app token minted from their own session', async () => {
    h.mockSelectLimit.mockResolvedValue([stored({ issuerDid: APP_DID, delegatorDid: DELEGATOR })]);
    h.verifySessionAppTokenLocal.mockResolvedValue({ sub: DELEGATOR, aud: 'dykil.example.com', scopes: [] });
    h.resolveActiveAppByAudience.mockResolvedValue({ id: 'app_dykil', appDid: APP_DID, status: 'active' });

    const res = await POST(appTokenReq('scoped-app-token'), ctx());

    expect(res.status).toBe(200);
  });

  it('returns 401 when the token verifies but its aud is not a live registered app', async () => {
    h.verifySessionAppTokenLocal.mockResolvedValue({ sub: ISSUER, aud: 'unregistered.example.com', scopes: [] });
    h.resolveActiveAppByAudience.mockResolvedValue(null);

    const res = await POST(appTokenReq('scoped-app-token'), ctx());

    expect(res.status).toBe(401);
    expect(h.mockUpdateSet).not.toHaveBeenCalled();
  });
});
