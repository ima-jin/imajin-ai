import { z } from 'zod';
import { tool } from 'ai';

export function createProfileTools(config: {
  profileUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getProfile: tool({
      description: 'Get a profile by DID or handle',
      parameters: z.object({
        didOrHandle: z.string().describe('DID or handle to look up'),
      }),
      execute: async ({ didOrHandle }) => {
        const res = await fetch(
          `${config.profileUrl}/api/profile/${encodeURIComponent(didOrHandle)}`,
          { headers: authHeaders }
        );
        return res.json();
      },
    }),

    searchProfiles: tool({
      description: 'Search profiles by query string',
      parameters: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }) => {
        const url = new URL('/api/profile/search', config.profileUrl);
        url.searchParams.set('q', query);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
