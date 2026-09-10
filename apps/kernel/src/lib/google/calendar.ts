/**
 * Google Calendar action library (#2144, v1).
 *
 * Reads are plain on-demand Calendar REST calls. Writes deliberately do NOT
 * create a parallel Google-specific table: per the issue ("Write INTO the
 * intention-model store per #1788 — calendar = time-indexed view, not a
 * parallel calendar table"), a created event is also inserted into the
 * existing `kernel.calendar_entries` store and announced on the existing
 * `calendar.entry.created` bus event (`apps/kernel/src/lib/calendar/index.ts`)
 * rather than a new `calendar.event.created` event — see the connector's
 * README note for why that is the correct reading of the issue's event name.
 */
import { createLogger } from '@imajin/logger';
import { db, calendarEntries } from '@/src/db';
import { generateId } from '../kernel/id';
import { publishCalendarEntry } from '../calendar';
import { requireGrantAndToken, googleApiFetch } from './connector';

const log = createLogger('kernel');

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

interface CalendarApiOptions {
  method?: 'GET' | 'POST';
  path: string;
  token: string;
  body?: Record<string, unknown>;
}

function callCalendarApi<T = unknown>(opts: Readonly<CalendarApiOptions>): Promise<T> {
  return googleApiFetch<T>({ ...opts, baseUrl: CALENDAR_API_BASE, apiLabel: 'Calendar' });
}

// ── Read tools (google:calendar:read) ────────────────────────────────────────

export interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
}

export interface ListEventsResult {
  events: GoogleCalendarEvent[];
  nextPageToken?: string;
}

/** List events on the primary calendar within an optional time window. */
export async function listEvents(
  ownerDid: string,
  options: { timeMin?: string; timeMax?: string; maxResults?: number; pageToken?: string } = {},
): Promise<ListEventsResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:calendar:read');
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime' });
  if (options.timeMin) params.set('timeMin', options.timeMin);
  if (options.timeMax) params.set('timeMax', options.timeMax);
  if (options.maxResults) params.set('maxResults', String(Math.min(options.maxResults, 250)));
  if (options.pageToken) params.set('pageToken', options.pageToken);

  const data = await callCalendarApi<{ items?: GoogleCalendarEvent[]; nextPageToken?: string }>({
    path: `/calendars/primary/events?${params.toString()}`,
    token,
  });
  return { events: data.items ?? [], nextPageToken: data.nextPageToken };
}

export interface FreeBusyResult {
  busy: Array<{ start: string; end: string }>;
}

/** Read free/busy for the primary calendar within a time window. */
export async function getFreeBusy(ownerDid: string, timeMin: string, timeMax: string): Promise<FreeBusyResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:calendar:read');
  const data = await callCalendarApi<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }>({
    method: 'POST',
    path: '/freeBusy',
    token,
    body: { timeMin, timeMax, items: [{ id: 'primary' }] },
  });
  return { busy: data.calendars?.primary?.busy ?? [] };
}

// ── Write tool (google:calendar:write) ───────────────────────────────────────

export interface CreateEventParams {
  summary: string;
  startIso: string;
  endIso: string;
  description?: string;
  /** When true, requests a Google Meet link on the created event. */
  withMeet?: boolean;
}

export interface CreateEventResult {
  googleEventId: string;
  calendarEntryId: string;
  hangoutLink?: string;
}

/**
 * Create a Calendar event on behalf of ownerDid (write tier — fail-closed on
 * `google:calendar:write`), then mirror it into the intention-model store
 * (#1788) and emit the store's own `calendar.entry.created` event.
 */
export async function createEvent(ownerDid: string, params: Readonly<CreateEventParams>): Promise<CreateEventResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:calendar:write');

  const body: Record<string, unknown> = {
    summary: params.summary,
    description: params.description,
    start: { dateTime: params.startIso },
    end: { dateTime: params.endIso },
  };
  const query = new URLSearchParams();
  if (params.withMeet) {
    body.conferenceData = {
      createRequest: { requestId: generateId('meet-req'), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
    query.set('conferenceDataVersion', '1');
  }

  const data = await callCalendarApi<GoogleCalendarEvent>({
    method: 'POST',
    path: `/calendars/primary/events?${query.toString()}`,
    token,
    body,
  });

  const calendarEntryId = generateId('cal');
  await db.insert(calendarEntries).values({
    id: calendarEntryId,
    did: ownerDid,
    type: 'event',
    title: params.summary,
    startsAt: new Date(params.startIso),
    endsAt: new Date(params.endIso),
    visibility: 'private',
    metadata: { source: 'google', googleEventId: data.id, googleCalendarId: 'primary' },
  });

  // Reuses the existing intention-model event rather than inventing
  // `calendar.event.created` — see this module's class doc.
  publishCalendarEntry('calendar.entry.created', ownerDid, ownerDid, calendarEntryId, 'event', log);

  return { googleEventId: data.id, calendarEntryId, hangoutLink: data.hangoutLink };
}
