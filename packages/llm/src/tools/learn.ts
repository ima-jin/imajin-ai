import { z } from 'zod';
import { tool } from 'ai';

export function createLearnTools(config: {
  learnUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getCourses: tool({
      description: 'List available courses on the platform',
      parameters: z.object({
        query: z.string().optional().describe('Optional search query'),
      }),
      execute: async ({ query }) => {
        const url = new URL('/api/courses', config.learnUrl);
        if (query) url.searchParams.set('q', query);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),

    getEnrollments: tool({
      description: 'Get course enrollments for a conversation participant',
      parameters: z.object({
        did: z.string().describe('DID to check enrollments for (must be a conversation participant)'),
      }),
      execute: async ({ did }) => {
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view enrollments for conversation participants' };
        }
        const url = new URL('/api/my/courses', config.learnUrl);
        url.searchParams.set('did', did);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
