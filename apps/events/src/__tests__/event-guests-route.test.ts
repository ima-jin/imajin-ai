/**
 * Tests for apps/events/app/api/events/[id]/guests/route.ts
 *
 * #1998: this route used to LEFT JOIN auth.identities / auth.credentials
 * directly in its ticket query, plus make a separate per-DID HTTP call to
 * AUTH_SERVICE_URL /api/lookup. It now runs a plain ticket query and
 * resolves owner/buyer identities in one batched call to
 * resolveIdentitiesForDids (backed by the profile service's /api/resolve).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireAuthMock: vi.fn(),
  requireAppAuthMock: vi.fn(),
  isEventOrganizerMock: vi.fn(),
  resolveIdentitiesForDidsMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  requireAppAuth: mocks.requireAppAuthMock,
  resolveIdentitiesForDids: mocks.resolveIdentitiesForDidsMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

// The root vitest config's `@/` alias points at apps/kernel, not apps/events,
// so `@/src/lib/attendee` must be mocked explicitly here. Reimplements the
// real (pure, dependency-free) precedence logic from
// apps/events/src/lib/attendee.ts so this suite still exercises realistic
// name/email resolution behavior.
vi.mock('@/src/lib/attendee', () => ({
  resolveAttendee: (params: {
    surveyName: string | null;
    surveyEmail: string | null;
    identityName: string | null;
    identityContactEmail: string | null;
    identityCredentialEmail: string | null;
    profileName: string | null;
    profileEmail: string | null;
    buyerName: string | null;
    buyerEmail: string | null;
  }) => {
    const norm = (s: string | null | undefined) => (s ?? '').trim();
    const name = norm(params.surveyName) || norm(params.profileName) || norm(params.identityName) || norm(params.buyerName);
    const email = norm(params.surveyEmail) || norm(params.identityContactEmail) || norm(params.identityCredentialEmail) || norm(params.profileEmail) || norm(params.buyerEmail);
    return { name, email, guestOf: '' };
  },
}));

import { GET } from '../../app/api/events/[id]/guests/route';

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/guests', {
    headers: { cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };

const TICKET_ROW = {
  id: 'tkt_1',
  status: 'valid',
  owner_did: 'did:imajin:owner',
  price_paid: 5000,
  currency: 'CAD',
  purchased_at: new Date().toISOString(),
  used_at: null,
  payment_method: 'stripe',
  payment_id: 'pi_1',
  hold_expires_at: null,
  registration_status: 'complete',
  last_email_sent_at: null,
  ticket_type: 'General',
  survey_answers: null,
  fair_settlement: null,
  amount_total: 5000,
  buyer_email: null,
  buyer_did: 'did:imajin:buyer',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:organizer', actingAs: null } });
  mocks.isEventOrganizerMock.mockResolvedValue({ authorized: true, role: 'creator' });
  mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map());
});

describe('GET .../guests — batched identity resolution (#1998)', () => {
  it('resolves owner and buyer DIDs in a single batched call', async () => {
    mocks.sqlMock.mockResolvedValueOnce([TICKET_ROW]);

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);

    expect(mocks.resolveIdentitiesForDidsMock).toHaveBeenCalledTimes(1);
    const requestedDids = mocks.resolveIdentitiesForDidsMock.mock.calls[0][0] as string[];
    expect(new Set(requestedDids)).toEqual(new Set(['did:imajin:owner', 'did:imajin:buyer']));
  });

  it('populates guest profile/email from the resolved map, not raw SQL columns', async () => {
    mocks.sqlMock.mockResolvedValueOnce([TICKET_ROW]);
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map([
      ['did:imajin:owner', { did: 'did:imajin:owner', handle: 'owner-handle', displayName: 'Owner Name', email: 'owner@example.com' }],
      ['did:imajin:buyer', { did: 'did:imajin:buyer', handle: 'buyer-handle', displayName: 'Buyer Name' }],
    ]));

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const json = await res.json();

    expect(json.guests).toHaveLength(1);
    expect(json.guests[0].profile).toEqual({
      name: 'Owner Name',
      handle: 'owner-handle',
      avatar: null,
      email: 'owner@example.com',
    });
    expect(json.guests[0].resolvedName).toBe('Owner Name');
    expect(json.guests[0].resolvedEmail).toBe('owner@example.com');
  });

  it('returns null profile for a ticket with no owner DID and skips resolution for it', async () => {
    mocks.sqlMock.mockResolvedValueOnce([{ ...TICKET_ROW, owner_did: null, buyer_did: null }]);

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const json = await res.json();

    expect(json.guests[0].profile).toBeNull();
    expect(mocks.resolveIdentitiesForDidsMock).toHaveBeenCalledWith([]);
  });

  it('returns 403 for a non-organizer', async () => {
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });
});
