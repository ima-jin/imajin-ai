import { z } from 'zod';
import { tool } from 'ai';

export function createConnectionTools(config: { connectionsUrl: string; apiKey?: string }) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getConnections: tool({
      description: 'List connections for a DID',
      parameters: z.object({
        did: z.string().describe('The DID to list connections for'),
      }),
      execute: async ({ did }) => {
        const url = new URL('/api/connections', config.connectionsUrl);
        url.searchParams.set('did', did);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),

    getTrustDistance: tool({
      description: 'Check the trust distance between two DIDs',
      parameters: z.object({
        from: z.string().describe('Source DID'),
        to: z.string().describe('Target DID'),
      }),
      execute: async ({ from, to }) => {
        const url = new URL('/api/trust/distance', config.connectionsUrl);
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
