import { z } from 'zod';
import { tool } from 'ai';
import { safeFetch } from './utils';

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
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view balance for conversation participants' };
        }
        return safeFetch(
          `${config.payUrl}/api/balance/${encodeURIComponent(did)}`,
          authHeaders,
        );
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
        return safeFetch(
          `${config.payUrl}/api/transactions/${encodeURIComponent(did)}`,
          authHeaders,
        );
      },
    }),
  };
}
