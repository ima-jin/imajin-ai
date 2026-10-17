import { getClient } from '@imajin/db';
import type { ReachEnvelope } from '@/src/db/schemas/reach';

export interface ReachStatus {
  reachId: string;
  state: 'delivered' | 'replied' | 'blocked';
  reply: Record<string, unknown> | null;
}

/**
 * Transport-independent receipt reader for C6/C7/C8. The requester DID must
 * come from a verified credential, never a tool argument or acting-as context.
 * A reach id is a correlation reference, not a bearer capability.
 */
export async function reachStatus(params: {
  principalDid: string;
  requesterDid: string;
  reachId: string;
}): Promise<ReachStatus | null> {
  const [row] = await getClient().unsafe<{
    envelope: ReachEnvelope & { reply?: Record<string, unknown> };
    blocked: boolean;
  }[]>(`
    SELECT e.envelope, EXISTS (
      SELECT 1 FROM auth.reach_sender_blocks b
      WHERE b.principal_did = e.principal_did AND b.requester_did = e.requester_did
    ) AS blocked
    FROM auth.reach_envelopes e
    WHERE e.principal_did = $1 AND e.requester_did = $2 AND e.reach_id = $3
  `, [params.principalDid, params.requesterDid, params.reachId]);
  if (!row) return null;
  if (row.blocked) return { reachId: params.reachId, state: 'blocked', reply: null };
  const reply = row.envelope.reply ?? null;
  return { reachId: params.reachId, state: reply ? 'replied' : 'delivered', reply };
}
