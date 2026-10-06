/**
 * Tests for the `etransferEmail` slice of the profile routes (#2665):
 * PUT /profile/api/profile/:id (owner-editable, business-scope only,
 * validated, clearable), the public GET withholding it from everyone but the
 * owner, and the owner-only GET /profile/api/profile/:id/etransfer-email the
 * settings UI reads it through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockFindFirst,
  mockRequireAuth,
  mockResolveActingDid,
  mockSelectLimit,
  mockSet,
  mockUpdateReturning,
  mockSession,
} = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockResolveActingDid = vi.fn();
  const mockSelectLimit = vi.fn();
  const mockUpdateReturning = vi.fn();
  const mockSession = vi.fn();
  const mockSet = vi.fn((_updates: Record<string, unknown>) => ({
    where: () => ({ returning: mockUpdateReturning }),
  }));
  return { mockFindFirst, mockRequireAuth, mockResolveActingDid, mockSelectLimit, mockSet, mockUpdateReturning, mockSession };
});

vi.mock('@/src/db', () => ({
  db: {
    query: { profiles: { findFirst: mockFindFirst } },
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    update: () => ({ set: mockSet }),
    insert: () => ({ values: vi.fn(() => Promise.resolve([])) }),
  },
  profiles: {},
  identityMembers: {},
  identities: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  requireAppAuth: vi.fn(),
  resolveActingDid: mockResolveActingDid,
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn(() => Promise.resolve()), broker: vi.fn(), isBrokerRelease: vi.fn(() => false) }));
vi.mock('@imajin/fair', () => ({ validateAgentPricingManifest: vi.fn(() => ({ valid: true })) }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: vi.fn(() => Promise.reject(new Error('not needed in these tests'))) }));
vi.mock('@/src/lib/profile/vault-contacts', () => ({
  processEmailUpdate: vi.fn(() => Promise.resolve()),
  processPhoneUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));
vi.mock('@/src/lib/kernel/session', () => ({ getSessionFromCookies: mockSession }));

import { GET, PUT } from '../route';
import { GET as GET_OWNER_EMAIL } from '../etransfer-email/route';

const BUSINESS_DID = 'did:imajin:biz';
const OTHER_DID = 'did:imajin:someone-else';

function putRequest(body: unknown): NextRequest {
  return new NextRequest(`https://kernel.test/profile/api/profile/${BUSINESS_DID}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function getRequest(path = ''): NextRequest {
  return new NextRequest(`https://kernel.test/profile/api/profile/${BUSINESS_DID}${path}`);
}

const params = () => ({ params: Promise.resolve({ id: BUSINESS_DID }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: BUSINESS_DID } });
  mockResolveActingDid.mockReturnValue(BUSINESS_DID);
  mockFindFirst.mockResolvedValue({ did: BUSINESS_DID, taxRegistrations: [], etransferEmail: 'pay@biz.example' });
  mockSelectLimit.mockResolvedValue([{ scope: 'business' }]);
  mockUpdateReturning.mockResolvedValue([{ did: BUSINESS_DID, etransferEmail: 'pay@biz.example' }]);
  mockSession.mockResolvedValue(null);
});

describe('PUT /profile/api/profile/:id — etransferEmail (#2665)', () => {
  it('persists the normalised (trimmed, lower-cased) address next to the tax registrations', async () => {
    const res = await PUT(putRequest({ etransferEmail: '  Pay@Biz.Example ' }), params());
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ etransferEmail: 'pay@biz.example' }));
  });

  it('clears it (stores null) on an empty string or null — the business stops accepting e-Transfer', async () => {
    await PUT(putRequest({ etransferEmail: '' }), params());
    expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ etransferEmail: null }));
    await PUT(putRequest({ etransferEmail: null }), params());
    expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ etransferEmail: null }));
  });

  it('does not touch it when the field is absent from the body', async () => {
    await PUT(putRequest({ bio: 'hello' }), params());
    expect(mockSet.mock.calls[0]![0]).not.toHaveProperty('etransferEmail');
  });

  it('rejects an invalid address with a 400 naming the field, and writes nothing', async () => {
    const res = await PUT(putRequest({ etransferEmail: 'not-an-email' }), params());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'etransferEmail' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('is business-scope only: a non-business identity gets a 403 and nothing is written', async () => {
    mockSelectLimit.mockResolvedValue([{ scope: 'actor' }]);
    const res = await PUT(putRequest({ etransferEmail: 'pay@biz.example' }), params());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('etransferEmail') });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('is owner-only: someone who is neither the profile DID nor acting as it gets a 403', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(OTHER_DID);
    const res = await PUT(putRequest({ etransferEmail: 'pay@biz.example' }), params());
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('is editable by someone acting for the business', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(BUSINESS_DID);
    const res = await PUT(putRequest({ etransferEmail: 'pay@biz.example' }), params());
    expect(res.status).toBe(200);
  });
});

describe('GET /profile/api/profile/:id — the email is owner-only (#2665)', () => {
  it('is withheld from an anonymous reader', async () => {
    const res = await GET(getRequest(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('etransferEmail');
  });

  it("is withheld from another signed-in user's session", async () => {
    mockSession.mockResolvedValue({ did: OTHER_DID });
    const body = await (await GET(getRequest(), params())).json();
    expect(body).not.toHaveProperty('etransferEmail');
    expect(JSON.stringify(body)).not.toContain('pay@biz.example');
  });

  it("is returned to the profile's own session", async () => {
    mockSession.mockResolvedValue({ did: BUSINESS_DID });
    const body = await (await GET(getRequest(), params())).json();
    expect(body.etransferEmail).toBe('pay@biz.example');
  });
});

describe('GET /profile/api/profile/:id/etransfer-email — owner-only read for the settings UI (#2665)', () => {
  const call = () => GET_OWNER_EMAIL(getRequest('/etransfer-email'), params());

  it('requires authentication', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    expect((await call()).status).toBe(401);
  });

  it('returns the email to the profile owner', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etransferEmail: 'pay@biz.example' });
  });

  it('returns null when none is set', async () => {
    mockFindFirst.mockResolvedValue({ did: BUSINESS_DID, etransferEmail: null });
    expect(await (await call()).json()).toEqual({ etransferEmail: null });
  });

  it('returns it to someone acting for the business', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(BUSINESS_DID);
    expect((await call()).status).toBe(200);
  });

  it('refuses anyone else with a 403 — and never leaks the address', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(OTHER_DID);
    const res = await call();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('pay@biz.example');
  });

  it('404s an unknown profile', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    expect((await call()).status).toBe(404);
  });

  it('500s cleanly on a database error', async () => {
    mockFindFirst.mockRejectedValue(new Error('db down'));
    expect((await call()).status).toBe(500);
  });
});
