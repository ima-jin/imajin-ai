import { z } from 'zod';
import { tool } from 'ai';

export function createPayTools(config: {
  payUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getBalance: tool({
      description: 'Get the balance for a conversation participant',
      parameters: z.object({
        did: z.string().describe('DID to check balance for (must be a conversation participant)'),
      }),
      execute: async ({ did }) => {
        // Scope: only self (pay tools are already self-query only, but defense in depth)
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view balance for conversation participants' };
        }
        const res = await fetch(
          `${config.payUrl}/api/balance/${encodeURIComponent(did)}`,
          { headers: authHeaders }
        );
        return res.json();
      },
    }),

    getTransactions: tool({
      description: 'Get transaction history for a conversation participant',
      parameters: z.object({
        did: z.string().describe('DID to get transactions for (must be a conversation participant)'),
      }),
      execute: async ({ did }) => {
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view transactions for conversation participants' };
        }
        const res = await fetch(
          `${config.payUrl}/api/transactions/${encodeURIComponent(did)}`,
          { headers: authHeaders }
        );
        return res.json();
      },
    }),
  };
}
