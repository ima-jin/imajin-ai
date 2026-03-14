import { z } from 'zod';
import { tool } from 'ai';

export function createEventTools(config: { eventsUrl: string; apiKey?: string }) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getEvents: tool({
      description: 'List events, optionally filtered by creator',
      parameters: z.object({
        creatorDid: z.string().optional().describe('Filter by event creator DID'),
      }),
      execute: async ({ creatorDid }) => {
        const url = new URL('/api/events', config.eventsUrl);
        if (creatorDid) url.searchParams.set('creator', creatorDid);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),

    getEventDetails: tool({
      description: 'Get details for a single event by ID',
      parameters: z.object({
        eventId: z.string().describe('The event ID'),
      }),
      execute: async ({ eventId }) => {
        const res = await fetch(
          `${config.eventsUrl}/api/events/${encodeURIComponent(eventId)}`,
          { headers: authHeaders }
        );
        return res.json();
      },
    }),

    getMyTickets: tool({
      description: 'Get tickets for a specific DID',
      parameters: z.object({
        did: z.string().describe('The DID to fetch tickets for'),
      }),
      execute: async ({ did }) => {
        const url = new URL('/api/events/mine', config.eventsUrl);
        url.searchParams.set('did', did);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
