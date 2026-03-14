import { z } from 'zod';
import { tool } from 'ai';
import { safeFetch } from './utils';

export function createConnectionTools(config: {
  connectionsUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getMutualConnections: tool({
      description: 'Find connections shared between you and the person you\'re talking to',
      parameters: z.object({}),
      execute: async () => {
        const [targetData, requesterData] = await Promise.all([
          safeFetch(`${config.connectionsUrl}/api/connections?did=${encodeURIComponent(config.targetDid)}`, authHeaders),
          safeFetch(`${config.connectionsUrl}/api/connections?did=${encodeURIComponent(config.requesterDid)}`, authHeaders),
        ]);

        // If either errored, return the error
        if (typeof targetData === 'object' && targetData && 'error' in targetData) return targetData;
        if (typeof requesterData === 'object' && requesterData && 'error' in requesterData) return requesterData;

        const targetConns = (targetData as any).connections ?? [];
        const requesterConns = (requesterData as any).connections ?? [];

        const targetDids = new Set(
          targetConns.map((c: { toDid: string; fromDid: string }) =>
            c.toDid === config.targetDid ? c.fromDid : c.toDid
          )
        );
        const mutual = requesterConns.filter(
          (c: { toDid: string; fromDid: string }) => {
            const otherDid = c.toDid === config.requesterDid ? c.fromDid : c.toDid;
            return targetDids.has(otherDid);
          }
        );

        return { mutual, count: mutual.length };
      },
    }),

    getTrustDistance: tool({
      description: 'Check the trust distance between two DIDs in the trust graph',
      parameters: z.object({
        from: z.string().describe('Source DID'),
        to: z.string().describe('Target DID'),
      }),
      execute: async ({ from, to }) => {
        if (from !== config.targetDid && from !== config.requesterDid) {
          return { error: 'Can only check distance from conversation participants' };
        }
        if (to !== config.targetDid && to !== config.requesterDid) {
          return { error: 'Can only check distance to conversation participants' };
        }
        const url = new URL('/api/trust/distance', config.connectionsUrl);
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        return safeFetch(url.toString(), authHeaders);
      },
    }),
  };
}
