import { z } from 'zod';
import { tool } from 'ai';

export function createLearnTools(config: { learnUrl: string; apiKey?: string }) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getCourses: tool({
      description: 'List available courses',
      parameters: z.object({}),
      execute: async () => {
        const res = await fetch(`${config.learnUrl}/api/courses`, { headers: authHeaders });
        return res.json();
      },
    }),

    getEnrollments: tool({
      description: 'Get course enrollments for a DID',
      parameters: z.object({
        did: z.string().describe('The DID to fetch enrollments for'),
      }),
      execute: async ({ did }) => {
        const url = new URL('/api/my/courses', config.learnUrl);
        url.searchParams.set('did', did);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
