/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/resend-email/route.ts
 *
 * #1998: this route used to run a raw `SELECT contact_email FROM
 * profile.profiles` query before falling back to `getEmailForDid`. It now
 * calls `resolveEmailForDid` (which itself calls the profile service's
 * batched `/api/resolve` route) directly, with no raw SQL for identity
 * resolution left in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const sqlMock = vi.fn().mockResolvedValue([]);

  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  return {
    sqlMock,
    whereMock,
    fromMock,
    selectMock,
    updateWhereMock,
    setMock,
    updateMock,
    requireAuthMock: vi.fn(),
    resolveEmailForDidMock: vi.fn(),
    isEventOrganizerMock: vi.fn(),
    publishMock: vi.fn().mockResolvedValue(undefined),
    generateQRCodeMock: vi.fn().mockResolvedValue('data:image/png;base64,stub'),
  };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
  },
  tickets: { id: 'col_id', eventId: 'col_eventId', ticketTypeId: 'col_ttId' },
  events: { id: 'col_id' },
  ticketTypes: { id: 'col_id' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveEmailForDid: mocks.resolveEmailForDidMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

vi.mock('@/src/lib/email', () => ({
  generateQRCode: mocks.generateQRCodeMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

vi.mock('@imajin/config', () => ({
  eventUrl: () => 'https://events.test/e/evt_1',
  eventRegisterUrl: () => 'https://events.test/e/evt_1/register',
  eventMyTicketsUrl: () => 'https://events.test/e/evt_1/my-tickets',
  buildPublicUrlAbsolute: () => 'https://events.test',
}));

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/resend-email/route';

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/tickets/tkt_1/resend-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

/** Queue a Drizzle select().from().where().limit() result for the next call. */
function nextDrizzleSelect(rows: unknown[]): void {
  mocks.whereMock.mockImplementationOnce(() => ({ limit: vi.fn().mockResolvedValue(rows) }));
}

const BASE_TICKET = {
  id: 'tkt_1',
  eventId: 'evt_1',
  ticketTypeId: 'tkt_type_1',
  ownerDid: 'did:imajin:buyer',
  registrationStatus: 'complete',
  lastEmailSentAt: null,
  pricePaid: 5000,
  currency: 'CAD',
};

const BASE_EVENT = {
  id: 'evt_1',
  title: 'Test Event',
  startsAt: new Date().toISOString(),
  imageUrl: null,
  isVirtual: false,
  venue: null,
};

const BASE_TICKET_TYPE = { id: 'tkt_type_1', name: 'General Admission' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockReset();
  mocks.sqlMock.mockReset();
  mocks.sqlMock.mockResolvedValue([]); // default: no survey response, no onboard-token insert result needed

  mocks.updateWhereMock.mockResolvedValue(undefined);
  mocks.publishMock.mockResolvedValue(undefined);
  mocks.generateQRCodeMock.mockResolvedValue('data:image/png;base64,stub');

  mocks.requireAuthMock.mockResolvedValue({
    identity: { id: 'did:imajin:organizer', actingAs: null },
  });
  mocks.isEventOrganizerMock.mockResolvedValue({ authorized: true });
  mocks.resolveEmailForDidMock.mockResolvedValue(null);
});

describe('POST .../resend-email — email resolution (#1998)', () => {
  it('prefers the survey response email and never calls resolveEmailForDid', async () => {
    nextDrizzleSelect([BASE_TICKET]);
    nextDrizzleSelect([BASE_EVENT]);
    nextDrizzleSelect([BASE_TICKET_TYPE]);
    mocks.sqlMock.mockResolvedValueOnce([{ answers: { email: 'survey@example.com' } }]); // survey_responses
    mocks.sqlMock.mockResolvedValueOnce([]); // onboard_tokens insert

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(mocks.resolveEmailForDidMock).not.toHaveBeenCalled();
  });

  it('falls back to resolveEmailForDid when there is no survey response email', async () => {
    nextDrizzleSelect([BASE_TICKET]);
    nextDrizzleSelect([BASE_EVENT]);
    nextDrizzleSelect([BASE_TICKET_TYPE]);
    mocks.sqlMock.mockResolvedValueOnce([]); // no survey response
    mocks.sqlMock.mockResolvedValueOnce([]); // onboard_tokens insert
    mocks.resolveEmailForDidMock.mockResolvedValue('resolved@example.com');

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(mocks.resolveEmailForDidMock).toHaveBeenCalledWith('did:imajin:buyer');
  });

  it('returns 422 when neither the survey nor resolveEmailForDid produce an email', async () => {
    nextDrizzleSelect([BASE_TICKET]);
    nextDrizzleSelect([BASE_EVENT]);
    nextDrizzleSelect([BASE_TICKET_TYPE]);
    mocks.sqlMock.mockResolvedValueOnce([]); // no survey response
    mocks.resolveEmailForDidMock.mockResolvedValue(null);

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Could not determine email/);
  });

  it('returns 404 when the ticket is not found', async () => {
    nextDrizzleSelect([]);

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });
});
