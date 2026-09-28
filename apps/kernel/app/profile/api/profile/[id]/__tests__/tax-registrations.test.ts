/**
 * Tests for the `tax_registrations` slice of PUT /profile/api/profile/:id
 * (#2420): auth, ownership, business-scope guard, validation, and the
 * normalise-then-persist round trip. The rest of this route's behaviour
 * (contact info, agentPricing, fieldVisibility, etc.) is exercised
 * elsewhere/pre-existing and is out of scope here.
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
} = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockResolveActingDid = vi.fn();
  const mockSelectLimit = vi.fn();
  const mockUpdateReturning = vi.fn();
  const mockSet = vi.fn((_updates: Record<string, unknown>) => ({
    where: () => ({ returning: mockUpdateReturning }),
  }));
  return { mockFindFirst, mockRequireAuth, mockResolveActingDid, mockSelectLimit, mockSet, mockUpdateReturning };
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

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn(() => Promise.resolve()),
  broker: vi.fn(),
  isBrokerRelease: vi.fn(() => false),
}));

vi.mock('@imajin/fair', () => ({
  validateAgentPricingManifest: vi.fn(() => ({ valid: true })),
}));

vi.mock('@/src/lib/vault', () => ({
  loadAndUnseal: vi.fn(() => Promise.reject(new Error('not needed in these tests'))),
}));

vi.mock('@/src/lib/profile/vault-contacts', () => ({
  processEmailUpdate: vi.fn(() => Promise.resolve()),
  processPhoneUpdate: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));

vi.mock('@/src/lib/kernel/session', () => ({
  getSessionFromCookies: vi.fn(() => Promise.resolve(null)),
}));

// Real validators (@/src/lib/profile) are intentionally NOT mocked — the
// round-trip test below asserts on their actual normalisation output.

import { GET, PUT } from '../route';

const BUSINESS_DID = 'did:imajin:biz';
const OTHER_DID = 'did:imajin:someone-else';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(`https://kernel.test/profile/api/profile/${BUSINESS_DID}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function params() {
  return { params: Promise.resolve({ id: BUSINESS_DID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: BUSINESS_DID } });
  mockResolveActingDid.mockReturnValue(BUSINESS_DID);
  mockFindFirst.mockResolvedValue({ did: BUSINESS_DID, taxRegistrations: [] });
  mockSelectLimit.mockResolvedValue([{ scope: 'business' }]);
  mockUpdateReturning.mockResolvedValue([{ did: BUSINESS_DID, taxRegistrations: [] }]);
});

describe('PUT /profile/api/profile/:id — auth + ownership (#2420)', () => {
  it('requires authentication', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    const res = await PUT(makeRequest({ taxRegistrations: [] }), params());
    expect(res.status).toBe(401);
  });

  it('rejects an actor who is neither the profile DID nor acting as it', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(OTHER_DID);
    const res = await PUT(makeRequest({ taxRegistrations: [] }), params());
    expect(res.status).toBe(403);
  });

  it('allows an actor acting-as the business DID even when directly authenticated as a different identity', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(BUSINESS_DID);
    const res = await PUT(makeRequest({ taxRegistrations: [] }), params());
    expect(res.status).toBe(200);
  });
});

describe('PUT /profile/api/profile/:id — business-scope guard (#2420)', () => {
  it('rejects setting taxRegistrations on a non-business identity', async () => {
    mockSelectLimit.mockResolvedValue([{ scope: 'actor' }]);
    const res = await PUT(
      makeRequest({ taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }] }),
      params()
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/business identity/);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does not query identity scope at all when taxRegistrations is absent from the body', async () => {
    const res = await PUT(makeRequest({ displayName: 'New Name' }), params());
    expect(res.status).toBe(200);
    expect(mockSelectLimit).not.toHaveBeenCalled();
  });
});

describe('PUT /profile/api/profile/:id — validation (#2420)', () => {
  it('rejects a malformed tax registration with per-index details', async () => {
    const res = await PUT(
      makeRequest({ taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: 'not-a-number' }] }),
      params()
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid tax registrations/);
    expect(data.details).toEqual([expect.stringMatching(/^taxRegistrations\[0\]/)]);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    const res = await PUT(
      makeRequest({ taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'INCOME_TAX', number: '123456789RT0001' }] }),
      params()
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-array taxRegistrations payload', async () => {
    const res = await PUT(makeRequest({ taxRegistrations: { jurisdiction: 'CA-ON' } }), params());
    expect(res.status).toBe(400);
  });
});

describe('GET /profile/api/profile/:id — public exposure (#2420)', () => {
  it('includes taxRegistrations in the public profile read, unfiltered', async () => {
    mockFindFirst.mockResolvedValue({
      did: BUSINESS_DID,
      claimStatus: null,
      metadata: {},
      fieldVisibility: {},
      taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }],
    });

    const res = await GET(new NextRequest(`https://kernel.test/profile/api/profile/${BUSINESS_DID}`), params());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.taxRegistrations).toEqual([{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }]);
  });
});

describe('PUT /profile/api/profile/:id — normalise + persist round trip (#2420)', () => {
  it('normalises the number before writing it, and returns the persisted value', async () => {
    mockUpdateReturning.mockResolvedValue([
      { did: BUSINESS_DID, taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }] },
    ]);

    const res = await PUT(
      makeRequest({ taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123-456-789-RT-0001' }] }),
      params()
    );

    expect(res.status).toBe(200);
    // What actually got written to the DB must already be normalised.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }],
      })
    );
    const data = await res.json();
    expect(data.taxRegistrations).toEqual([{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }]);
  });

  it('replaces the full array rather than merging with the existing one', async () => {
    mockFindFirst.mockResolvedValue({
      did: BUSINESS_DID,
      taxRegistrations: [{ jurisdiction: 'CA-QC', kind: 'QST', number: '1234567890TQ0001' }],
    });
    mockUpdateReturning.mockResolvedValue([
      { did: BUSINESS_DID, taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }] },
    ]);

    await PUT(
      makeRequest({ taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }] }),
      params()
    );

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }],
      })
    );
  });

  it('clears all registrations when saving an empty array', async () => {
    mockFindFirst.mockResolvedValue({
      did: BUSINESS_DID,
      taxRegistrations: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }],
    });
    mockUpdateReturning.mockResolvedValue([{ did: BUSINESS_DID, taxRegistrations: [] }]);

    const res = await PUT(makeRequest({ taxRegistrations: [] }), params());

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ taxRegistrations: [] }));
  });
});
