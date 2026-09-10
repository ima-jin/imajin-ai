import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireGrantAndTokenMock, insertValuesMock, publishCalendarEntryMock } = vi.hoisted(() => ({
  requireGrantAndTokenMock: vi.fn(),
  insertValuesMock: vi.fn(),
  publishCalendarEntryMock: vi.fn(),
}));

vi.mock('../connector', () => ({
  requireGrantAndToken: requireGrantAndTokenMock,
  googleApiFetch: async (opts: { baseUrl: string; path: string; token: string; method?: string; body?: unknown; apiLabel: string }) => {
    const url = opts.path.startsWith('http') ? opts.path : `${opts.baseUrl}${opts.path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
    const init: RequestInit = { method: opts.method ?? 'GET', headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${opts.apiLabel} API error ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  },
}));
vi.mock('@/src/db', () => ({
  db: { insert: () => ({ values: insertValuesMock }) },
  calendarEntries: { id: 'id' },
}));
vi.mock('../../calendar', () => ({ publishCalendarEntry: publishCalendarEntryMock }));

import { listEvents, getFreeBusy, createEvent } from '../calendar';

const OWNER = 'did:imajin:jin';
const TOKEN = 'calendar-access-token';

// Recorded fixture shapes (Google Calendar API v3).
const EVENTS_FIXTURE = {
  items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-01-01T10:00:00Z' }, end: { dateTime: '2026-01-01T10:30:00Z' } }],
};
const FREEBUSY_FIXTURE = { calendars: { primary: { busy: [{ start: '2026-01-01T09:00:00Z', end: '2026-01-01T10:00:00Z' }] } } };
const CREATE_EVENT_FIXTURE = { id: 'ge1', hangoutLink: 'https://meet.google.com/abc-defg-hij' };

beforeEach(() => {
  requireGrantAndTokenMock.mockReset();
  requireGrantAndTokenMock.mockResolvedValue(TOKEN);
  insertValuesMock.mockReset();
  insertValuesMock.mockResolvedValue(undefined);
  publishCalendarEntryMock.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listEvents (google:calendar:read)', () => {
  it('fails closed without a grant', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(listEvents(OWNER)).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists events against the recorded fixture shape', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => EVENTS_FIXTURE });
    const result = await listEvents(OWNER, { timeMin: '2026-01-01T00:00:00Z' });
    expect(result.events).toEqual(EVENTS_FIXTURE.items);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/calendars/primary/events?');
    expect(url).toContain('singleEvents=true');
  });
});

describe('getFreeBusy (google:calendar:read)', () => {
  it('reads busy blocks for the primary calendar', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => FREEBUSY_FIXTURE });
    const result = await getFreeBusy(OWNER, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    expect(result.busy).toEqual(FREEBUSY_FIXTURE.calendars.primary.busy);
  });
});

describe('createEvent (google:calendar:write)', () => {
  it('fails closed without google:calendar:write', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(
      createEvent(OWNER, { summary: 'x', startIso: '2026-01-01T10:00:00Z', endIso: '2026-01-01T10:30:00Z' }),
    ).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates the Google event, mirrors it into calendar_entries, and reuses calendar.entry.created', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => CREATE_EVENT_FIXTURE });

    const result = await createEvent(OWNER, {
      summary: 'Kickoff', startIso: '2026-01-01T10:00:00Z', endIso: '2026-01-01T10:30:00Z', withMeet: true,
    });

    expect(result.googleEventId).toBe('ge1');
    expect(result.hangoutLink).toBe(CREATE_EVENT_FIXTURE.hangoutLink);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      did: OWNER, type: 'event', title: 'Kickoff',
      metadata: expect.objectContaining({ source: 'google', googleEventId: 'ge1' }),
    }));
    // Reuses the existing intention-model event rather than a new google-specific one.
    expect(publishCalendarEntryMock).toHaveBeenCalledWith('calendar.entry.created', OWNER, OWNER, result.calendarEntryId, 'event', expect.anything());
  });

  it('requests conferenceDataVersion=1 only when withMeet is set', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ id: 'ge2' }) });
    await createEvent(OWNER, { summary: 'No meet', startIso: '2026-01-01T10:00:00Z', endIso: '2026-01-01T10:30:00Z' });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).not.toContain('conferenceDataVersion');
  });
});
