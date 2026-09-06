/**
 * Tests for apps/events/app/api/events/[id]/sales/export/route.ts
 *
 * #1998: this route used to hit a per-DID AUTH_SERVICE_URL /api/lookup
 * internal-route fallback to resolve buyer name/handle/email. It now calls
 * the batched resolveIdentitiesForDids client (backed by the profile
 * service's /api/resolve) once for all buyer DIDs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  nextSql,
  resetResolveRouteMocks,
  requireAuthMock,
  isEventOrganizerMock,
  resolveIdentitiesForDidsMock,
} from './support/resolve-route-test-support';

import { GET } from '../../app/api/events/[id]/sales/export/route';

function makeRequest(query = ''): Request {
  return new Request(`https://events.test/api/events/evt_1/sales/export${query}`, {
    headers: { cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };

const EVENT_ROW = { id: 'evt_1', title: 'Test Event' };

const ORDER_ROW = {
  order_id: 'ord_1',
  buyer_did: 'did:imajin:buyer',
  quantity: 1,
  amount_total: 5000,
  currency: 'CAD',
  payment_method: 'stripe',
  stripe_session_id: 'cs_1',
  payment_id: 'pi_1',
  purchased_at: new Date().toISOString(),
  ticket_type: 'General',
};

const TICKET_ROW = { id: 'tkt_1', status: 'valid', order_id: 'ord_1' };

beforeEach(resetResolveRouteMocks);

describe('GET .../sales/export — batched identity resolution (#1998)', () => {
  it('resolves buyer identities in one batched call and includes them in the CSV', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([TICKET_ROW]);
    resolveIdentitiesForDidsMock.mockResolvedValue(new Map([
      ['did:imajin:buyer', { displayName: 'Buyer Name', handle: 'buyer-handle', email: 'buyer@example.com' }],
    ]));

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(resolveIdentitiesForDidsMock).toHaveBeenCalledWith(['did:imajin:buyer']);
    expect(text).toContain('Buyer Name');
    expect(text).toContain('buyer-handle');
    expect(text).toContain('buyer@example.com');
    expect(text).toContain('completed'); // computeOrderStatus: valid ticket -> completed
  });

  it('emits blank buyer fields when the DID does not resolve to any identity', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([]); // no tickets -> computeOrderStatus 'unknown'

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('unknown');
  });

  it('uses the xlsx content type and filename extension when format=xlsx', async () => {
    nextSql([EVENT_ROW]);
    nextSql([]); // no orders
    nextSql([]); // no tickets

    const res = await GET(makeRequest('?format=xlsx') as any, ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml');
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx');
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
