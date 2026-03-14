import { z } from 'zod';
import { tool } from 'ai';

export function createPayTools(config: { payUrl: string; apiKey?: string }) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getBalance: tool({
      description: 'Get balance for a DID',
      parameters: z.object({
        did: z.string().describe('The DID to fetch balance for'),
      }),
      execute: async ({ did }) => {
        const res = await fetch(
          `${config.payUrl}/api/balance/${encodeURIComponent(did)}`,
          { headers: authHeaders }
        );
        return res.json();
      },
    }),

    getTransactions: tool({
      description: 'Get transaction history for a DID',
      parameters: z.object({
        did: z.string().describe('The DID to fetch transactions for'),
      }),
      execute: async ({ did }) => {
        const url = new URL('/api/transactions', config.payUrl);
        url.searchParams.set('did', did);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
