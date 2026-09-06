/**
 * Tests for apps/events/app/e/[eventId]/edit/page.tsx
 *
 * #1998: this page used to run raw `SELECT contact_email FROM
 * profile.profiles` and `SELECT handle, name FROM auth.identities` queries
 * to resolve the event creator's contact info. It now calls the batched
 * resolveIdentitiesForDids client (backed by the profile service's
 * /api/resolve) once for the creator DID.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const sqlMock = Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(queue.shift() ?? []),
    { queue },
  );
  return {
    sqlMock,
    getSessionMock: vi.fn(),
    resolveIdentitiesForDidsMock: vi.fn(),
    dbSelectMock: vi.fn(),
    redirectMock: vi.fn(),
    notFoundMock: vi.fn(),
    formMock: vi.fn(() => null),
  };
});

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.orderBy = vi.fn(async () => result);
  return chain;
}

function nextSql(rows: unknown[]): void {
  mocks.sqlMock.queue.push(rows);
}

vi.mock('next/navigation', () => ({
  redirect: mocks.redirectMock,
  notFound: mocks.notFoundMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@imajin/auth', () => ({
  getSession: mocks.getSessionMock,
  resolveIdentitiesForDids: mocks.resolveIdentitiesForDidsMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/db', () => ({
  db: { select: (...args: unknown[]) => mocks.dbSelectMock(...args) },
  events: { id: 'events.id', creatorDid: 'events.creator_did' },
  ticketTypes: { eventId: 'ticket_types.event_id', sortOrder: 'ticket_types.sort_order' },
}));

vi.mock('../../app/e/[eventId]/edit/form', () => ({
  default: mocks.formMock,
}));

import EditEventPage from '../../app/e/[eventId]/edit/page';

const EVENT = { id: 'evt_1', creatorDid: 'did:imajin:creator', podId: null };
const ROUTE_PARAMS = { params: Promise.resolve({ eventId: 'evt_1' }) };

/** Recursively search a React element tree (as returned, unrendered) for an element whose `type` matches. */
function findElementByType(node: unknown, type: unknown): ReactElement<any> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as ReactElement<any>;
  if (el.type === type) return el;
  const children = (el.props as { children?: unknown })?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElementByType(child, type);
      if (found) return found;
    }
  } else if (children) {
    return findElementByType(children, type);
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sqlMock.queue.length = 0;
  mocks.getSessionMock.mockResolvedValue({ id: 'did:imajin:creator', actingAs: null });
  mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map());
});

describe('EditEventPage — creator identity resolution (#1998)', () => {
  it('resolves the creator email/handle/name via resolveIdentitiesForDids and passes them to the form', async () => {
    mocks.dbSelectMock
      .mockReturnValueOnce(selectChain([EVENT])) // getEvent
      .mockReturnValueOnce(selectChain([])); // getTicketTypes
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map([
      ['did:imajin:creator', { displayName: 'Creator Name', handle: 'creator-handle', email: 'creator@example.com' }],
    ]));

    const element = await EditEventPage(ROUTE_PARAMS as any);

    expect(mocks.resolveIdentitiesForDidsMock).toHaveBeenCalledWith(['did:imajin:creator']);
    const formElement = findElementByType(element, mocks.formMock);
    expect(formElement).not.toBeNull();
    expect(formElement!.props).toMatchObject({
      creatorEmail: 'creator@example.com',
      creatorHandle: 'creator-handle',
      creatorName: 'Creator Name',
    });
  });

  it('falls back to null creator fields when the DID does not resolve', async () => {
    mocks.dbSelectMock
      .mockReturnValueOnce(selectChain([EVENT]))
      .mockReturnValueOnce(selectChain([]));
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map());

    const element = await EditEventPage(ROUTE_PARAMS as any);

    const formElement = findElementByType(element, mocks.formMock);
    expect(formElement!.props).toMatchObject({
      creatorEmail: null,
      creatorHandle: null,
      creatorName: null,
    });
  });

  it('does not fail the page when resolveIdentitiesForDids rejects', async () => {
    mocks.dbSelectMock
      .mockReturnValueOnce(selectChain([EVENT]))
      .mockReturnValueOnce(selectChain([]));
    mocks.resolveIdentitiesForDidsMock.mockRejectedValue(new Error('profile service down'));

    const element = await EditEventPage(ROUTE_PARAMS as any);

    const formElement = findElementByType(element, mocks.formMock);
    expect(formElement!.props).toMatchObject({ creatorEmail: null, creatorHandle: null, creatorName: null });
  });

  it('redirects to login when there is no session', async () => {
    mocks.getSessionMock.mockResolvedValue(null);
    // Real next/navigation redirect() throws to halt rendering; mirror that.
    mocks.redirectMock.mockImplementation(() => { throw new Error('NEXT_REDIRECT'); });

    await expect(EditEventPage(ROUTE_PARAMS as any)).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirectMock).toHaveBeenCalledWith(expect.stringContaining('/login'));
    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('renders a not-authorized message for a non-organizer, non-cohost session', async () => {
    mocks.dbSelectMock.mockReturnValueOnce(selectChain([EVENT])); // getEvent only
    mocks.getSessionMock.mockResolvedValue({ id: 'did:imajin:stranger', actingAs: null });

    const element = await EditEventPage(ROUTE_PARAMS as any);

    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
    expect(JSON.stringify(element)).toContain('Not Authorized');
  });

  it('calls notFound() when the event does not exist', async () => {
    mocks.dbSelectMock.mockReturnValueOnce(selectChain([])); // getEvent misses
    mocks.notFoundMock.mockImplementation(() => { throw new Error('NEXT_NOT_FOUND'); });

    await expect(EditEventPage(ROUTE_PARAMS as any)).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mocks.notFoundMock).toHaveBeenCalled();
    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('authorizes a cohost via pod membership and gathers organizer DIDs for the survey dropdown', async () => {
    const eventWithPod = { ...EVENT, podId: 'pod_1' };
    mocks.dbSelectMock
      .mockReturnValueOnce(selectChain([eventWithPod])) // getEvent
      .mockReturnValueOnce(selectChain([])); // getTicketTypes
    mocks.getSessionMock.mockResolvedValue({ id: 'did:imajin:cohost', actingAs: null });
    nextSql([{ did: 'did:imajin:cohost' }]); // cohost membership check hits
    nextSql([{ did: 'did:imajin:another-cohost' }]); // cohosts list for survey dropdown
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map([
      ['did:imajin:creator', { displayName: 'Creator Name', handle: 'creator-handle', email: 'creator@example.com' }],
    ]));

    const element = await EditEventPage(ROUTE_PARAMS as any);

    const formElement = findElementByType(element, mocks.formMock);
    expect(formElement).not.toBeNull();
    expect(formElement!.props.organizerDids).toEqual(['did:imajin:creator', 'did:imajin:another-cohost']);
  });
});
