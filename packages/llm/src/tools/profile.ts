import { z } from 'zod';
import { tool } from 'ai';

export function createProfileTools(config: { profileUrl: string; apiKey?: string }) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getProfile: tool({
      description: 'Get a profile by DID or handle',
      parameters: z.object({
        id: z.string().describe('DID or handle of the profile to fetch'),
      }),
      execute: async ({ id }) => {
        const res = await fetch(
          `${config.profileUrl}/api/profile/${encodeURIComponent(id)}`,
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
        const url = new URL('/api/profile', config.profileUrl);
        url.searchParams.set('q', query);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
