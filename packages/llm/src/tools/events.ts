import { z } from 'zod';
import { tool } from 'ai';
import { safeFetch } from './utils';

export function createEventTools(config: {
  eventsUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getEvents: tool({
      description: 'List events created by or relevant to the conversation participants',
      parameters: z.object({
        creatorDid: z.string().optional().describe('Filter by event creator DID (must be a conversation participant)'),
      }),
      execute: async ({ creatorDid }) => {
        const did = creatorDid || config.targetDid;
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view events for conversation participants' };
        }
        const url = new URL('/api/events', config.eventsUrl);
        url.searchParams.set('creator', did);
        return safeFetch(url.toString(), authHeaders);
      },
    }),

    getEventDetails: tool({
      description: 'Get details for a single event by ID',
      parameters: z.object({
        eventId: z.string().describe('The event ID'),
      }),
      execute: async ({ eventId }) => {
        return safeFetch(
          `${config.eventsUrl}/api/events/${encodeURIComponent(eventId)}`,
          authHeaders,
        );
      },
    }),

    getRequesterTickets: tool({
      description: 'Get the asking person\'s tickets (what events they\'re attending)',
      parameters: z.object({}),
      execute: async () => {
        const url = new URL('/api/events/mine', config.eventsUrl);
        url.searchParams.set('did', config.requesterDid);
        return safeFetch(url.toString(), authHeaders);
      },
    }),
  };
}
