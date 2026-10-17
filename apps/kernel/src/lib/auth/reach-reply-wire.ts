import type { ReachEnvelope } from '@/src/db/schemas/reach';

export interface ReachReplySignature {
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

export interface ReachReplyEvent {
  type: 'agent.reach.replied';
  issuer: string;
  subject: string;
  scope: 'agent';
  payload: {
    reachId: string;
    principalDid: string;
    requesterDid: string;
    transcriptHash: string;
    message: string;
    issuedAt: string;
    state: 'replied';
    context_id: string;
    context_type: 'agent.reach';
  };
}

export type SignedReachReplyEvent = Omit<ReachReplyEvent, 'payload'> & {
  payload: ReachReplyEvent['payload'] & { signature: ReachReplySignature };
};

/** Browser-safe, exact unsigned event the principal signs with their own key. */
export function reachReplyEvent(
  envelope: Pick<ReachEnvelope, 'reachId' | 'principalDid' | 'requesterDid' | 'transcriptHash'>,
  message: string,
  issuedAt: string,
): ReachReplyEvent {
  const { reachId, principalDid, requesterDid, transcriptHash } = envelope;
  return {
    type: 'agent.reach.replied', issuer: principalDid, subject: principalDid, scope: 'agent',
    payload: {
      reachId, principalDid, requesterDid, transcriptHash, message, issuedAt,
      state: 'replied', context_id: reachId, context_type: 'agent.reach',
    },
  };
}

/** Same sorted-key JSON encoding as auth canonicalize, without server imports. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function canonicalReachReply(event: ReachReplyEvent): string {
  return canonicalJson(event);
}
