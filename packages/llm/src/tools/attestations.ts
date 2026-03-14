import { z } from 'zod';
import { tool } from 'ai';

export function createAttestationTools(config: { authUrl: string; apiKey?: string }) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getAttestations: tool({
      description: 'Get attestations for a DID, with optional type filter',
      parameters: z.object({
        did: z.string().describe('The DID to fetch attestations for'),
        type: z.string().optional().describe('Filter by attestation type'),
      }),
      execute: async ({ did, type }) => {
        const url = new URL(`/api/attestations/${encodeURIComponent(did)}`, config.authUrl);
        if (type) url.searchParams.set('type', type);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
