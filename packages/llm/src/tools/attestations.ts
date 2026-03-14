import { z } from 'zod';
import { tool } from 'ai';
import { safeFetch } from './utils';

export function createAttestationTools(config: {
  authUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getAttestations: tool({
      description: 'Get attestations (vouches, transactions, session history) for a conversation participant',
      parameters: z.object({
        did: z.string().describe('The DID to look up attestations for (must be a conversation participant)'),
        type: z.string().optional().describe('Filter by attestation type (e.g. vouch, transaction.settled, session.created)'),
      }),
      execute: async ({ did, type }) => {
        if (did !== config.targetDid && did !== config.requesterDid) {
          return { error: 'Can only view attestations for conversation participants' };
        }
        const url = new URL(`/api/attestations/${encodeURIComponent(did)}`, config.authUrl);
        if (type) url.searchParams.set('type', type);
        return safeFetch(url.toString(), authHeaders);
      },
    }),
  };
}
