/**
 * Admin page confirmed-attendee count (#2734): the broadcast composer's count
 * must use the same holding statuses as the message recipients query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  AdminTabs: () => null,
}));

vi.mock('@/src/lib/ticket-holding', async () => await import('../../../../src/lib/ticket-holding'));
vi.mock('@imajin/auth', () => ({
  getSession: async () => ({ id: 'did:imajin:organizer' }),
  resolveActingDid: (s: { id: string }) => s.id,
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}), desc: () => ({}) }));
vi.mock('../admin-tabs', () => ({ AdminTabs: mocks.AdminTabs }));
vi.mock('@/src/db', () => {
  const EVENT = { id: 'evt_1', title: 'Show', creatorDid: 'did:imajin:organizer', status: 'published', accessMode: 'public', startsAt: new Date('2030-01-01T00:00:00Z'), podId: null };
  const rowsFor = (table: unknown) => (table === 'events' ? [EVENT] : []);
  const chain = (table: unknown) => {
    const c: Record<string, unknown> = {};
    c.where = () => c;
    c.leftJoin = () => c;
    c.orderBy = () => c;
    c.limit = () => c;
    c.then = (resolve: (r: unknown) => unknown) => Promise.resolve(rowsFor(table)).then(resolve);
    return c;
  };
  return {
    db: { select: () => ({ from: (t: unknown) => chain(t) }) },
    events: 'events',
    tickets: { eventId: 'e', ticketTypeId: 't', createdAt: 'c' },
    ticketTypes: { eventId: 'e', id: 'i', name: 'n' },
  };
});

import AdminPage from '../page';
import { HOLDING_TICKET_STATUSES } from '../../../../src/lib/ticket-holding';

function findByType(node: unknown, type: unknown): ReactElement | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const el = node as ReactElement<{ children?: unknown }>;
  if (el.type === type) return el;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findByType(child, type);
    if (hit) return hit;
  }
  return undefined;
}

beforeEach(() => {
  mocks.sql.mockReset();
  mocks.sql.mockResolvedValue([{ count: '3' }]);
});

describe('AdminPage — confirmed attendee count', () => {
  it('counts attendees with the shared holding statuses and passes the count to AdminTabs', async () => {
    const page = await AdminPage({ params: Promise.resolve({ eventId: 'evt_1' }) });

    const tabs = findByType(page, mocks.AdminTabs);
    expect(tabs?.props).toMatchObject({ confirmedAttendeeCount: 3 });

    const boundByAnyCall = mocks.sql.mock.calls.some(([, ...values]) =>
      values.some((v) => Array.isArray(v) && v.join() === [...HOLDING_TICKET_STATUSES].join()),
    );
    expect(boundByAnyCall).toBe(true);
  });
});
