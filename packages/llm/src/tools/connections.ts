import { z } from 'zod';
import { tool } from 'ai';

export function createConnectionTools(config: {
  connectionsUrl: string;
  targetDid: string;
  requesterDid: string;
  apiKey?: string;
}) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    getMutualConnections: tool({
      description: 'Find connections shared between you and the person you\'re talking to',
      parameters: z.object({}),
      execute: async () => {
        // Fetch both connection lists and intersect
        const [targetRes, requesterRes] = await Promise.all([
          fetch(`${config.connectionsUrl}/api/connections?did=${encodeURIComponent(config.targetDid)}`, { headers: authHeaders }),
          fetch(`${config.connectionsUrl}/api/connections?did=${encodeURIComponent(config.requesterDid)}`, { headers: authHeaders }),
        ]);
        const targetConns = await targetRes.json();
        const requesterConns = await requesterRes.json();

        // Extract DIDs from both sides
        const targetDids = new Set(
          (targetConns.connections ?? []).map((c: { toDid: string; fromDid: string }) =>
            c.toDid === config.targetDid ? c.fromDid : c.toDid
          )
        );
        const mutual = (requesterConns.connections ?? []).filter(
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
        // Scope: only allow queries involving the conversation participants
        if (from !== config.targetDid && from !== config.requesterDid) {
          return { error: 'Can only check distance from conversation participants' };
        }
        if (to !== config.targetDid && to !== config.requesterDid) {
          return { error: 'Can only check distance to conversation participants' };
        }
        const url = new URL('/api/trust/distance', config.connectionsUrl);
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        const res = await fetch(url.toString(), { headers: authHeaders });
        return res.json();
      },
    }),
  };
}
