/**
 * MCP Google Calendar connector tools (#2144, v1).
 *
 * `google_calendar_list_events` / `google_calendar_free_busy` — requiredScope: 'google:calendar:read'
 * `google_calendar_create_event`                              — requiredScope: 'google:calendar:write'
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { listEvents, getFreeBusy, createEvent } from '@/src/lib/google/calendar';

const listEventsTool: McpTool = {
  name: 'google_calendar_list_events',
  requiredScope: 'google:calendar:read',
  description:
    'List events on your primary Google Calendar within an optional time window (ISO-8601). ' +
    'Requires an active google:calendar:read grant.',
  inputSchema: {
    type: 'object',
    properties: {
      timeMin: { type: 'string', description: 'ISO-8601 lower bound (inclusive)' },
      timeMax: { type: 'string', description: 'ISO-8601 upper bound (exclusive)' },
      maxResults: { type: 'number', description: 'Max events to return (default 20, ceiling 250)' },
      pageToken: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const result = await listEvents(ctx.did, {
      timeMin: str(args, 'timeMin'),
      timeMax: str(args, 'timeMax'),
      maxResults: num(args, 'maxResults'),
      pageToken: str(args, 'pageToken'),
    });
    return json(result);
  },
};

const freeBusyTool: McpTool = {
  name: 'google_calendar_free_busy',
  requiredScope: 'google:calendar:read',
  description: 'Read your free/busy blocks on your primary calendar within a time window. Requires google:calendar:read.',
  inputSchema: {
    type: 'object',
    properties: {
      timeMin: { type: 'string', description: 'ISO-8601 lower bound' },
      timeMax: { type: 'string', description: 'ISO-8601 upper bound' },
    },
    required: ['timeMin', 'timeMax'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const timeMin = str(args, 'timeMin');
    const timeMax = str(args, 'timeMax');
    if (timeMin === undefined || timeMax === undefined) throw new Error('timeMin and timeMax are required');
    return json(await getFreeBusy(ctx.did, timeMin, timeMax));
  },
};

const createEventTool: McpTool = {
  name: 'google_calendar_create_event',
  requiredScope: 'google:calendar:write',
  description:
    'Create an event on your primary Google Calendar on your behalf, optionally with a Google Meet link. ' +
    'The event is also mirrored into your own calendar entries (kernel intention-model store) and announced as a ' +
    'signed calendar.entry.created event. Requires an active google:calendar:write grant.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      startIso: { type: 'string', description: 'ISO-8601 start time' },
      endIso: { type: 'string', description: 'ISO-8601 end time' },
      description: { type: 'string' },
      withMeet: { type: 'boolean', description: 'Request a Google Meet link on the event' },
    },
    required: ['summary', 'startIso', 'endIso'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const summary = str(args, 'summary');
    const startIso = str(args, 'startIso');
    const endIso = str(args, 'endIso');
    if (summary === undefined || startIso === undefined || endIso === undefined) {
      throw new Error('summary, startIso, and endIso are all required');
    }
    const withMeet = args.withMeet === true;
    return json(await createEvent(ctx.did, { summary, startIso, endIso, description: str(args, 'description'), withMeet }));
  },
};

export const calendarTools: McpTool[] = [listEventsTool, freeBusyTool, createEventTool];
