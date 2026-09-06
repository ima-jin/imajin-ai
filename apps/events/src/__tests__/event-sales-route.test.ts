/**
 * Tests for apps/events/app/api/events/[id]/sales/route.ts
 *
 * #1998: this route used to LEFT JOIN auth.identities / auth.credentials
 * directly for buyer and orphan-ticket-owner identity. It now runs a plain
 * SQL query and resolves those DIDs via the batched resolveIdentitiesForDids
 * client (backed by the profile service's /api/resolve).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  nextSql,
  resetResolveRouteMocks,
  requireAuthMock,
  isEventOrganizerMock,
  resolveIdentitiesForDidsMock,
} from './support/resolve-route-test-support';

import { GET } from '../../app/api/events/[id]/sales/route';

function makeRequest(query = ''): Request {
  return new Request(`https://events.test/api/events/evt_1/sales${query}`, {
    headers: { cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };

const EVENT_ROW = { id: 'evt_1', title: 'Test Event', currency: 'CAD' };

const ORDER_ROW = {
  order_id: 'ord_1',
  buyer_did: 'did:imajin:buyer',
  amount_total: 5000,
  currency: 'CAD',
  order_status: 'completed',
  payment_method: 'stripe',
  stripe_session_id: 'cs_1',
  purchased_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  ticket_id: 'tkt_1',
  ticket_status: 'valid',
  ticket_type_name: 'General',
  attendee_name: 'Attendee',
  attendee_email: 'attendee@example.com',
  transaction_id: 'tx_1',
  tx_amount: 5000,
  tx_status: 'succeeded',
  tx_stripe_id: 'cs_1',
  tx_metadata: {},
};

const ORPHAN_ROW = {
  ticket_id: 'tkt_orphan',
  status: 'valid',
  owner_did: 'did:imajin:orphan-owner',
  price_paid: 2500,
  currency: 'CAD',
  purchased_at: new Date().toISOString(),
  payment_method: 'etransfer',
  payment_id: null,
  ticket_type_name: 'General',
  attendee_name: 'Orphan Attendee',
  attendee_email: 'orphan@example.com',
};

beforeEach(resetResolveRouteMocks);

describe('GET .../sales — batched identity resolution (#1998)', () => {
  it('resolves buyer and orphan-owner DIDs via resolveIdentitiesForDids and returns JSON', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([ORPHAN_ROW]);
    resolveIdentitiesForDidsMock
      .mockResolvedValueOnce(new Map([['did:imajin:buyer', { displayName: 'Buyer Name', handle: 'buyer-handle', email: 'buyer@example.com' }]]))
      .mockResolvedValueOnce(new Map([['did:imajin:orphan-owner', { displayName: 'Orphan Owner', handle: 'orphan-handle', email: 'owner@example.com' }]]));

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(resolveIdentitiesForDidsMock).toHaveBeenNthCalledWith(1, ['did:imajin:buyer']);
    expect(resolveIdentitiesForDidsMock).toHaveBeenNthCalledWith(2, ['did:imajin:orphan-owner']);

    const orderSale = json.sales.find((s: any) => s.orderId === 'ord_1');
    expect(orderSale.buyerName).toBe('Buyer Name');
    expect(orderSale.buyerHandle).toBe('buyer-handle');
    expect(orderSale.buyerEmail).toBe('buyer@example.com');

    const orphanSale = json.sales.find((s: any) => s.orderId === 'tkt_orphan');
    expect(orphanSale.buyerName).toBe('Orphan Owner');
    expect(orphanSale.buyerHandle).toBe('orphan-handle');
    expect(orphanSale.buyerEmail).toBe('owner@example.com');
  });

  it('falls back to the survey attendee name when no identity resolves for the orphan owner', async () => {
    nextSql([EVENT_ROW]);
    nextSql([]); // no orders
    nextSql([ORPHAN_ROW]);

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    const json = await res.json();

    const orphanSale = json.sales.find((s: any) => s.orderId === 'tkt_orphan');
    expect(orphanSale.buyerName).toBe('Orphan Attendee');
    expect(orphanSale.buyerHandle).toBeNull();
    expect(orphanSale.buyerEmail).toBeNull();
  });

  it('returns a CSV download when format=csv is requested', async () => {
    nextSql([EVENT_ROW]);
    nextSql([ORDER_ROW]);
    nextSql([]); // no orphans
    resolveIdentitiesForDidsMock
      .mockResolvedValueOnce(new Map([['did:imajin:buyer', { displayName: 'Buyer Name', handle: 'buyer-handle', email: 'buyer@example.com' }]]))
      .mockResolvedValueOnce(new Map());

    const res = await GET(makeRequest('?format=csv') as any, ROUTE_PARAMS);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(text).toContain('Buyer Name');
    expect(text).toContain('buyer-handle');
  });

  it('returns 404 when the event is not found', async () => {
    nextSql([]); // event lookup misses

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-organizer without querying orders', async () => {
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
});
