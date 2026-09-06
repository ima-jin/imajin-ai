/**
 * Tests for apps/events/app/api/events/[id]/guests/export.csv/route.ts
 *
 * #1998: this route used to LEFT JOIN auth.identities / auth.credentials
 * directly in its ticket query, plus make a separate per-DID HTTP call to
 * AUTH_SERVICE_URL /api/lookup. It now runs a plain ticket query and
 * resolves owner/buyer identities in one batched call to
 * resolveIdentitiesForDids (backed by the profile service's /api/resolve).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  nextSql,
  resetResolveRouteMocks,
  requireAuthMock,
  isEventOrganizerMock,
  resolveIdentitiesForDidsMock,
} from './support/resolve-route-test-support';

const helperMocks = vi.hoisted(() => ({
  warnDuplicateSurveyResponsesMock: vi.fn().mockResolvedValue(undefined),
  loadSurveyFormDataMock: vi.fn().mockResolvedValue({ surveyColumns: [], formFieldMap: {} }),
  buildSurveyValuesMock: vi.fn().mockReturnValue([]),
}));

vi.mock('@/src/lib/guest-export-helpers', () => ({
  warnDuplicateSurveyResponses: helperMocks.warnDuplicateSurveyResponsesMock,
  loadSurveyFormData: helperMocks.loadSurveyFormDataMock,
  buildSurveyValues: helperMocks.buildSurveyValuesMock,
}));

import { GET } from '../../app/api/events/[id]/guests/export.csv/route';

function makeRequest(query = ''): Request {
  return new Request(`https://events.test/api/events/evt_1/guests/export.csv${query}`, {
    headers: { cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };
const EVENT_ROW = { id: 'evt_1', title: 'Test Event' };

const TICKET_ROW = {
  id: 'tkt_1',
  status: 'valid',
  owner_did: 'did:imajin:owner',
  purchased_at: new Date().toISOString(),
  payment_method: 'stripe',
  ticket_payment_id: 'pi_1',
  payment_confirmed_at: null,
  registration_status: 'complete',
  order_id: 'ord_1',
  ticket_type: 'General',
  registration_form_id: null,
  survey_response_id: null,
  survey_form_id: null,
  survey_answers: null,
  order_payment_id: null,
  stripe_session_id: null,
  buyer_email: null,
  buyer_did: 'did:imajin:buyer',
};

beforeEach(() => {
  resetResolveRouteMocks();
  helperMocks.warnDuplicateSurveyResponsesMock.mockResolvedValue(undefined);
  helperMocks.loadSurveyFormDataMock.mockResolvedValue({ surveyColumns: [], formFieldMap: {} });
  helperMocks.buildSurveyValuesMock.mockReturnValue([]);
});

describe('GET .../guests/export.csv — batched identity resolution (#1998)', () => {
  it('resolves owner and buyer DIDs in a single batched call and includes them in the CSV', async () => {
    nextSql([EVENT_ROW]);
    nextSql([TICKET_ROW]);
    resolveIdentitiesForDidsMock.mockResolvedValue(new Map([
      ['did:imajin:owner', { displayName: 'Owner Name', handle: 'owner-handle', email: 'owner@example.com' }],
      ['did:imajin:buyer', { displayName: 'Buyer Name', handle: 'buyer-handle', email: 'buyer@example.com' }],
    ]));

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(new Set(resolveIdentitiesForDidsMock.mock.calls[0][0])).toEqual(
      new Set(['did:imajin:owner', 'did:imajin:buyer']),
    );
    expect(text).toContain('Owner Name');
    expect(text).toContain('owner@example.com');
  });

  it('falls back to the buyer identity when the owner does not resolve', async () => {
    nextSql([EVENT_ROW]);
    nextSql([TICKET_ROW]);
    resolveIdentitiesForDidsMock.mockResolvedValue(new Map([
      ['did:imajin:buyer', { displayName: 'Buyer Name', handle: 'buyer-handle', email: 'buyer@example.com' }],
    ]));

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const text = await res.text();

    expect(text).toContain('Buyer Name');
  });

  it('returns a JSON summary when summary=1 without resolving identities', async () => {
    nextSql([EVENT_ROW]);
    nextSql([{ ...TICKET_ROW, status: 'cancelled' }]);

    const res = await GET(makeRequest('?summary=1') as any, ROUTE_PARAMS);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ total: 1, cancelled: 1, valid: 0 });
    expect(resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the event is not found', async () => {
    nextSql([]); // event lookup misses

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-organizer', async () => {
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('returns 401 when auth fails', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    isEventOrganizerMock.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(500);
  });
});
