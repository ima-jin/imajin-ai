import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import type { KnockRecord } from '../auth/knock';
import { computeApprovalContentHash } from './operator-approvals';

const log = createLogger('kernel:reach-approvals');

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
  const knocks = (await listPendingKnocksForTarget(principalDid))
    .filter((knock) => knock.status === 'pending' && Date.parse(knock.expiresAt) > Date.now());
  const knockFields = knocks.map(knockCardFields);
  const candidates = [
    ...envelopes.filter((envelope) => !envelope.reply && !envelope.approvalDecision).map((envelope) => ({
      ...reachCardFields(envelope), signerDid: envelope.requesterDid,
    })),
    ...knockFields.map((fields, index) => ({ ...fields, signerDid: knocks[index].agentDid })),
  ].map(({ signerDid, ...fields }) => ({
    ...fields, signerDid, contentHash: computeApprovalContentHash(fields),
  }));
  if (!candidates.length) return;

  // A retry or concurrent publication must never replace signed evidence or
  // rewind a decision. RETURNING also limits push to genuinely new cards.
  const inserted = await getClient().unsafe<{ proposal_id: string }[]>(`
    INSERT INTO operator.approvals
      (proposal_id, operator_did, source, kind, summary, keys_touched, detail,
       content_hash, notification_id, signer_did, status)
    SELECT card."proposalId", $1, card.source, card.kind, card.summary,
           card."keysTouched", card.detail, card."contentHash", NULL, card."signerDid", 'pending'
    FROM jsonb_to_recordset($2::jsonb) AS card(
      "proposalId" text, source text, kind text, summary text, "keysTouched" jsonb,
      detail jsonb, "contentHash" text, "signerDid" text
    )
    ON CONFLICT (proposal_id) DO NOTHING
    RETURNING proposal_id
  `, [principalDid, JSON.stringify(candidates)]);

  if (knockFields.length) {
    // Retire all superseded pending knock cards in one statement. Only state
    // changes: the old detail/content hash and any prior decision stay intact.
    await getClient().unsafe(`
      UPDATE operator.approvals AS approval
      SET status = 'expired', updated_at = statement_timestamp()
      FROM jsonb_to_recordset($2::jsonb) AS current("knockId" text, "proposalId" text)
      WHERE approval.operator_did = $1 AND approval.source = 'knock'
        AND approval.kind = 'knock:request' AND approval.status = 'pending'
        AND approval.detail->>'knockId' = current."knockId"
        AND approval.proposal_id <> current."proposalId"
    `, [principalDid, JSON.stringify(knockFields.map((fields) => ({
      knockId: fields.detail.knockId, proposalId: fields.proposalId,
    })))]);
  }

  // One aggregate push avoids per-card subscription/VAPID queries. As on the
  // ordinary publish path, transport failure cannot undo durable publication.
  if (inserted.length) {
    const { pushWebNotificationToOperator } = await import('./web-push');
    void pushWebNotificationToOperator(principalDid, {
      title: 'Operator approvals needed',
      body: `${inserted.length} incoming Reach or knock request${inserted.length === 1 ? '' : 's'}`,
      url: '/jin',
    }).catch((err: unknown) => {
      log.error({ err: String(err), principalDid }, 'recovered approval web-push failed (non-fatal)');
    });
  }
}
