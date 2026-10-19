import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { getClient } from '@imajin/db';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import type { KnockRecord } from '../auth/knock';
import { computeApprovalContentHash } from './operator-approvals';
import { forEachSequential } from '../async/sequential';

export function reachCardFields(envelope: ReachEnvelope) {
  return {
    proposalId: `reach:${envelope.reachId}`, source: 'reach', kind: 'reach:message',
    summary: 'Incoming Reach message', keysTouched: [],
    detail: {
      principalDid: envelope.principalDid, requesterDid: envelope.requesterDid,
      requesterTier: envelope.requesterTier, topic: envelope.topic, message: envelope.message,
      onBehalfOf: {
        platform: envelope.onBehalfOf.platform, externalRef: envelope.onBehalfOf.externalRef,
        ...(envelope.onBehalfOf.selfDescription === undefined ? {} : { selfDescription: envelope.onBehalfOf.selfDescription }),
      },
      claimVerified: false, transcriptHash: envelope.transcriptHash, reachId: envelope.reachId,
    },
  };
}

/** Hash only persisted, requester-controlled fields; no identity verification is inferred. */
export function knockTranscript(knock: KnockRecord): string {
  return createHash('sha256').update(canonicalize({
    knockId: knock.knockId, requesterDid: knock.agentDid, principalDid: knock.declaredTarget,
    selfDescription: knock.selfDescription, externalDid: knock.externalDid,
    requestedCapabilities: knock.requestedCapabilities, expiresAt: knock.expiresAt,
  })).digest('hex');
}

export function knockCardFields(knock: KnockRecord) {
  const transcriptHash = knockTranscript(knock);
  return {
    proposalId: `knock:${knock.knockId}:${transcriptHash}`, source: 'knock', kind: 'knock:request',
    summary: 'Incoming agent knock', keysTouched: [],
    detail: {
      principalDid: knock.declaredTarget, requesterDid: knock.agentDid, requesterTier: 'unknown',
      topic: 'general', message: knock.selfDescription ?? '',
      onBehalfOf: {
        platform: 'unspecified', externalRef: knock.externalDid ?? knock.agentDid,
        ...(knock.selfDescription ? { selfDescription: knock.selfDescription } : {}),
      },
      claimVerified: false, transcriptHash, knockId: knock.knockId, expiresAt: knock.expiresAt,
    },
  };
}

export async function publishReachApproval(envelope: ReachEnvelope): Promise<void> {
  // Legacy replies must not reappear as undecided shared cards.
  if (envelope.reply || envelope.approvalDecision) return;
  const { recordApprovalRequested } = await import('./operator-approvals-service');
  const fields = reachCardFields(envelope);
  await recordApprovalRequested({
    ...fields, operatorDid: envelope.principalDid, contentHash: computeApprovalContentHash(fields),
    notificationId: null, signerDid: envelope.requesterDid,
  });
}

export async function publishKnockApproval(knock: KnockRecord): Promise<void> {
  if (knock.status !== 'pending' || Date.parse(knock.expiresAt) <= Date.now()) return;
  const { recordApprovalRequested } = await import('./operator-approvals-service');
  const fields = knockCardFields(knock);
  await recordApprovalRequested({
    ...fields, operatorDid: knock.declaredTarget, contentHash: computeApprovalContentHash(fields),
    notificationId: null, signerDid: knock.agentDid,
  });
  // Refresh retires the old evidence, never mutates something already signed.
  await getClient().unsafe(`
    UPDATE operator.approvals SET status = 'expired', updated_at = statement_timestamp()
    WHERE operator_did = $1 AND source = 'knock' AND kind = 'knock:request'
      AND detail->>'knockId' = $2 AND proposal_id <> $3 AND status = 'pending'
  `, [knock.declaredTarget, knock.knockId, fields.proposalId]);
}

/** Recover a failed publication or pre-upgrade pending row on ordinary Inbox reads. */
export async function backfillReachApprovals(principalDid: string): Promise<void> {
  const { listReachEnvelopes } = await import('../auth/reach-envelope-store');
  const { listPendingKnocksForTarget } = await import('../auth/knock');
  const envelopes = await listReachEnvelopes({ principalDid, limit: 100 });
  await forEachSequential(envelopes, publishReachApproval);
  await forEachSequential(await listPendingKnocksForTarget(principalDid), publishKnockApproval);
}
