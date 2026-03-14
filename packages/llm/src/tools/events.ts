import { z } from 'zod';
import { tool } from 'ai';

export function createEventTools(config: {
  eventsUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getEvents: tool({
      description: 'List events created by or relevant to the conversation participants',
      parameters: z.object({
        creatorDid: z.string().optional().describe('Filter by event creator DID (must be a conversation participant)'),
      }),
      execute: async ({ creatorDid }) => {
        // Scope: only target or requester's events
        const did = creatorDid || config.targetDid;
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view events for conversation participants' };
        }
        const url = new URL('/api/events', config.eventsUrl);
        url.searchParams.set('creator', did);
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

    getRequesterTickets: tool({
      description: 'Get the asking person\'s tickets (what events they\'re attending)',
      parameters: z.object({}),
      execute: async () => {
        const url = new URL('/api/events/mine', config.eventsUrl);
        url.searchParams.set('did', config.requesterDid);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
