import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { rateLimit } from '@imajin/config';
import type { BusEventMap } from '@imajin/bus';
import { resolveFrontDoorConfig } from '@/src/lib/jin/front-door';
import { generateId } from '@/src/lib/kernel/id';
import { persistReachEnvelope } from './reach-envelope-store';
import type { ReachRequestInput } from './agent-reach';
import type { ReachDeliveryInput } from './reach-delivery-input';
import { prepareMechanicalAttestation } from './emit-mechanical-attestation';

type DeliveredEvent = {
  issuer: string;
  subject: string;
  scope: string;
  payload: BusEventMap['agent.reach.delivered'];
};

export type ReachDeliveryResult =
  | { outcome: 'declined' | 'rate_limited' | 'blocked' }
  | { outcome: 'delivered'; reachId: string; published: boolean; event: DeliveredEvent };

/** No transport is opened: replyHandle is opaque state for #2589. */
export async function deliverReach(params: {
  principalDid: string;
  input: ReachRequestInput & ReachDeliveryInput;
  metadata: unknown;
  requesterTier: string;
  onBehalfOfStubDid: string;
  grantId: string | null;
  transcriptHash: string;
  admitted: boolean;
  /** Bearer possession is authenticated, but is NOT a requester transcript signature. */
  requesterAuthTier?: 'signed' | 'bearer';
}): Promise<ReachDeliveryResult> {
  const { input, principalDid } = params;
  const config = resolveFrontDoorConfig(params.metadata, true);
  const topicConfig = config.topics[input.topic];
  if (!params.admitted || !topicConfig?.open || !topicConfig.published || topicConfig.mode !== 'deliver') {
    return { outcome: 'declined' };
  }
  if (rateLimit(`reach:send:${principalDid}:${input.requesterDid}`, 5, 60_000).limited) {
    return { outcome: 'rate_limited' };
  }

  const { getNodeSigningIdentity } = await import('@/src/lib/vault/sealing');
  const identity = getNodeSigningIdentity();
  const reachId = generateId('reach');
  const issuedAt = new Date().toISOString();
  const unsignedPayload = {
    reachId, principalDid, requesterDid: input.requesterDid,
    onBehalfOfStubDid: params.onBehalfOfStubDid,
    onBehalfOf: input.onBehalfOf, claimVerified: false as const,
    requesterTier: params.requesterTier,
    requesterAuthTier: params.requesterAuthTier ?? 'signed',
    topic: input.topic, message: input.message, replyHandle: input.replyHandle,
    transcriptHash: params.transcriptHash, requesterSignature: input.signature,
    requestIssuedAt: input.issuedAt, issuedAt, grantId: params.grantId,
    source: 'reach' as const, context_id: reachId, context_type: 'agent.reach' as const,
    url: `/jin?lane=inbox&reachId=${encodeURIComponent(reachId)}`,
  };
  const provenance = {
    type: 'agent.reach.delivered' as const,
    issuer: identity.senderDid, subject: principalDid, scope: 'agent', payload: unsignedPayload,
  };
  const event: DeliveredEvent = {
    issuer: provenance.issuer, subject: principalDid, scope: 'agent',
    payload: {
      ...unsignedPayload,
      signature: {
        keyId: identity.senderPubkey.toLowerCase(),
        alg: 'ed25519',
        sig: authCrypto.signSync(canonicalize(provenance), identity.privateKeyHex).toLowerCase(),
      },
    },
  };
  const stored = await persistReachEnvelope({
    ...unsignedPayload,
    dailyCap: config.dailyCap,
    signedEvent: { type: provenance.type, ...event },
    deliveryAttestation: await prepareMechanicalAttestation({
      subjectDid: principalDid,
      type: 'agent.reach',
      contextId: reachId,
      contextType: 'agent.reach',
      payload: {
        requesterDid: input.requesterDid, principalDid, reachId,
        onBehalfOfStubDid: params.onBehalfOfStubDid,
        transcriptHash: params.transcriptHash, requesterSignature: input.signature,
        signatureVerified: params.requesterAuthTier !== 'bearer', grantId: params.grantId, outcome: 'delivered',
      },
    }, `att_reach_${reachId}`),
  });
  if (!stored.stored) return { outcome: stored.reason };
  return {
    outcome: 'delivered', reachId: stored.reachId, published: stored.published,
    event: stored.signedEvent as unknown as DeliveredEvent,
  };
}
