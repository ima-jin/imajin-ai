/**
 * Tests for apps/events/app/api/events/[id]/message/route.ts GET (#2734)
 *
 * Broadcast recipients are ticket holders; every recipient query (everyone and
 * each filter) must bind the shared holding-status list, so bought (`valid`)
 * and checked-in (`used`) tickets are included and `held`/`cancelled` are not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
}));

// No `@/` alias in vitest: resolve the shared constant to the real module (not a stub).
vi.mock('@/src/lib/ticket-holding', async () => await import('../lib/ticket-holding'));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: async () => ({ identity: { id: 'did:imajin:organizer' } }),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/config', () => ({
  eventUrl: () => 'https://events.test/e/evt_1',
  buildPublicUrlAbsolute: () => 'https://events.test',
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: async () => ({ authorized: true }),
}));

import { GET } from '../../app/api/events/[id]/message/route';
import { HOLDING_TICKET_STATUSES } from '../lib/ticket-holding';

function call(query = '') {
  const request = new Request(`https://events.test/api/events/evt_1/message${query}`);
  return GET(request as never, { params: Promise.resolve({ id: 'evt_1' }) });
}

/** Bound values (not SQL text) of the most recent tagged-template call. */
function lastBoundValues(): unknown[] {
  const [, ...values] = mocks.sql.mock.calls.at(-1) ?? [];
  return values;
}

beforeEach(() => {
  mocks.sql.mockReset();
  mocks.sql.mockResolvedValue([{ owner_did: 'did:imajin:a' }, { owner_did: 'did:imajin:b' }]);
});

describe('GET /api/events/[id]/message — recipient holding statuses', () => {
  it.each([
    ['everyone (no filter)', ''],
    ['ticket_type', '?filterType=ticket_type&ticketTypeId=tt_1'],
    ['registration_complete', '?filterType=registration_complete'],
    ['registration_incomplete', '?filterType=registration_incomplete'],
  ])('binds the shared holding statuses for %s', async (_label, query) => {
    const res = await call(query);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
    expect(lastBoundValues()).toContainEqual([...HOLDING_TICKET_STATUSES]);
  });

  it('falls back to the everyone query for ticket_type without ids', async () => {
    const res = await call('?filterType=ticket_type');

    expect(res.status).toBe(200);
    expect(lastBoundValues()).toContainEqual([...HOLDING_TICKET_STATUSES]);
  });

  it('returns 500 when the recipient query fails', async () => {
    mocks.sql.mockRejectedValue(new Error('db down'));

    const res = await call();

    expect(res.status).toBe(500);
  });
});
