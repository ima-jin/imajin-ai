import { z } from 'zod';
import { tool } from 'ai';
import { safeFetch } from './utils';

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
        return safeFetch(
          `${config.profileUrl}/api/profile/${encodeURIComponent(didOrHandle)}`,
          authHeaders,
        );
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
        return safeFetch(url.toString(), authHeaders);
      },
    }),
  };
}
