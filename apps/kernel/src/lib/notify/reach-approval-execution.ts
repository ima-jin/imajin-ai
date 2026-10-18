import { getClient } from '@imajin/db';
import type { Identity } from '@imajin/auth';
import type { OperatorApprovalRow } from '@/src/db';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import type { KnockRecord } from '../auth/knock';
import { didFromPublicKey } from '../auth/crypto';
import { dmDid } from '../chat/conversation-did';
import { blockReachSenderInTransaction } from '../auth/reach-envelope-store';
import { isReachSenderBlockedInTransaction, type ReachBlockReader } from '../auth/reach-block';
import { canDecideReach } from './reach-approval-authority';
import { computeApprovalContentHash, type OperatorApprovalDecidedPayload } from './operator-approvals';
import { knockCardFields, reachCardFields } from './reach-approvals';

type Tx = ReachBlockReader;
type SignedDecision = { payload: OperatorApprovalDecidedPayload; signature: string; senderPubkey: string };

export class ReachDecisionError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

interface KnockSqlRow {
  id: string; agent_did: string; declared_target: string; public_key: string;
  self_description: string | null; requested_capabilities: string[]; external_did: string | null;
  status: 'pending' | 'accepted' | 'declined'; expires_at: Date; created_at: Date;
}

function knockRecord(row: KnockSqlRow): KnockRecord {
  return {
    knockId: row.id, agentDid: row.agent_did, declaredTarget: row.declared_target,
    selfDescription: row.self_description, requestedCapabilities: row.requested_capabilities,
    externalDid: row.external_did, externalDidVerification: null, externalDidVerifiedAt: null,
    status: row.status, expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadEvidence(tx: Tx, row: OperatorApprovalRow) {
  const detail = row.detail ?? {};
  if (row.source === 'reach') {
    const [stored] = await tx.unsafe<{ envelope: ReachEnvelope }[]>(`
      SELECT envelope FROM auth.reach_envelopes WHERE principal_did = $1 AND reach_id = $2 FOR UPDATE
    `, [row.operatorDid, String(detail.reachId)]);
    if (!stored || stored.envelope.reply || stored.envelope.approvalDecision) throw new ReachDecisionError('Reach is no longer awaiting a decision');
    return { fields: reachCardFields(stored.envelope), envelope: stored.envelope, knock: null };
  }
  const [knock] = await tx.unsafe<KnockSqlRow[]>(`
    SELECT * FROM auth.agent_knocks WHERE declared_target = $1 AND id = $2 FOR UPDATE
  `, [row.operatorDid, String(detail.knockId)]);
  if (!knock || knock.status !== 'pending' || new Date(knock.expires_at).getTime() <= Date.now()) {
    throw new ReachDecisionError('Knock is no longer awaiting a decision');
  }
  return { fields: knockCardFields(knockRecord(knock)), envelope: null, knock };
}

/** Accept is the sole identity promotion / DM creation path. No grants or identity-member roles. */
async function acceptSender(tx: Tx, principalDid: string, requesterDid: string, knock: KnockSqlRow | null): Promise<string> {
  let agentDid = requesterDid;
  let publicKey = knock?.public_key;
  if (!publicKey) {
    const [identity] = await tx.unsafe<{ id: string; public_key: string; subtype: string }[]>(
      'SELECT id, public_key, subtype FROM auth.identities WHERE id = $1', [requesterDid],
    );
    if (identity && identity.subtype !== 'foreign_agent_stub' && /^[0-9a-f]{64}$/i.test(identity.public_key)) {
      agentDid = identity.id;
      publicKey = identity.public_key;
    } else {
      const [stub] = await tx.unsafe<{ signer_key: string }[]>(`
        SELECT signer_key FROM auth.foreign_agent_stubs
        WHERE principal_did = $1 AND revoked_at IS NULL
          AND (stub_did = $2 OR requester_did = $2 OR requester_aliases @> $3::jsonb)
        LIMIT 1
      `, [principalDid, requesterDid, JSON.stringify([requesterDid])]);
      publicKey = stub?.signer_key;
      if (publicKey) agentDid = didFromPublicKey(publicKey);
    }
  }
  if (!publicKey || !/^[0-9a-f]{64}$/i.test(publicKey)) throw new ReachDecisionError('Sender has no verified key to accept');
  await tx.unsafe(`
    INSERT INTO auth.identities (id, scope, subtype, public_key, tier, metadata)
    VALUES ($1, 'actor', 'agent', $2, 'preliminary', '{"onboardedVia":"inbox"}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [agentDid, publicKey]);
  const [registered] = await tx.unsafe<{ public_key: string; scope: string; subtype: string }[]>(
    'SELECT public_key, scope, subtype FROM auth.identities WHERE id = $1 FOR SHARE', [agentDid],
  );
  if (registered?.public_key.toLowerCase() !== publicKey.toLowerCase()) throw new ReachDecisionError('Sender key mismatch');
  if (registered.scope !== 'actor' || !['human', 'agent'].includes(registered.subtype)) {
    throw new ReachDecisionError('Sender identity cannot be promoted');
  }
  await tx.unsafe(`
    UPDATE auth.foreign_agent_stubs SET promoted_to = $3
    WHERE principal_did = $1 AND revoked_at IS NULL
      AND (signer_key = $2 OR signer_aliases @> $4::jsonb)
  `, [principalDid, publicKey, agentDid, JSON.stringify([publicKey])]);
  const [didA, didB] = [principalDid, agentDid].sort((a, b) => a.localeCompare(b));
  await tx.unsafe(`
    INSERT INTO connections.connections (did_a, did_b) VALUES ($1, $2)
    ON CONFLICT (did_a, did_b) DO UPDATE SET disconnected_at = NULL, connected_at = statement_timestamp()
  `, [didA, didB]);
  const conversationDid = dmDid(principalDid, agentDid);
  await tx.unsafe(`
    INSERT INTO chat.conversations_v2 (did, type, created_by) VALUES ($1, 'dm', $2)
    ON CONFLICT (did) DO NOTHING
  `, [conversationDid, principalDid]);
  await tx.unsafe(`
    INSERT INTO chat.conversation_members (conversation_did, member_did, role)
    VALUES ($1, $2, 'member'), ($1, $3, 'member')
    ON CONFLICT (conversation_did, member_did) DO UPDATE SET left_at = NULL
  `, [conversationDid, principalDid, agentDid]);
  return conversationDid;
}

/** Atomic domain mutation + signed decision. A thrown error rolls everything back for retry. */
export async function commitReachDecision(row: OperatorApprovalRow, signed: SignedDecision, identity: Identity): Promise<void> {
  await getClient().begin('isolation level read committed', async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reach:${row.operatorDid}`]);
    if (!await canDecideReach(identity, row.operatorDid, tx)) throw new ReachDecisionError('Not authorized to decide this Reach card', 403);
    const [actor] = await tx.unsafe<{ public_key: string }[]>(
      'SELECT public_key FROM auth.identities WHERE id = $1 FOR SHARE', [identity.id],
    );
    if (actor?.public_key.toLowerCase() !== signed.payload.operatorSignature?.keyId.toLowerCase()) {
      throw new ReachDecisionError('Actor signing key changed; sign again', 400);
    }
    const [current] = await tx.unsafe<{ status: string; content_hash: string }[]>(
      'SELECT status, content_hash FROM operator.approvals WHERE proposal_id = $1 FOR UPDATE', [row.proposalId],
    );
    if (!current || current.status !== 'pending' || current.content_hash !== row.contentHash) throw new ReachDecisionError('Proposal changed before decision');
    const { fields, envelope, knock } = await loadEvidence(tx, row);
    if (computeApprovalContentHash(fields) !== row.contentHash) throw new ReachDecisionError('Request evidence changed; refresh Inbox');
    const requesterDid = fields.detail.requesterDid;
    const blockParams = { principalDid: row.operatorDid, requesterDid, ...(envelope ? { onBehalfOfStubDid: envelope.onBehalfOfStubDid } : {}) };
    const mode = signed.payload.mode;
    if (mode !== 'block' && await isReachSenderBlockedInTransaction(tx, blockParams)) throw new ReachDecisionError('Sender is blocked', 403);
    if (mode === 'block') await blockReachSenderInTransaction(tx, blockParams);
    const conversationDid = mode === 'accept' ? await acceptSender(tx, row.operatorDid, requesterDid, knock) : null;
    if (envelope) {
      await tx.unsafe(`
        UPDATE auth.reach_envelopes SET envelope = jsonb_set(envelope, '{approvalDecision}', $3::jsonb)
        WHERE principal_did = $1 AND reach_id = $2
      `, [row.operatorDid, envelope.reachId, JSON.stringify({ payload: signed.payload, evidence: fields })]);
    }
    if (knock && mode !== 'reply') {
      await tx.unsafe(`
        UPDATE auth.agent_knocks SET status = $2, responded_at = statement_timestamp() WHERE id = $1
      `, [knock.id, mode === 'accept' ? 'accepted' : 'declined']);
    }
    await tx.unsafe(`
      UPDATE operator.approvals SET status = 'applied', decision = $2::jsonb, outcome = $3::jsonb,
        applied_at = statement_timestamp(), updated_at = statement_timestamp()
      WHERE proposal_id = $1
    `, [row.proposalId, JSON.stringify(signed), JSON.stringify({ mode, ...(conversationDid ? { conversationDid } : {}) })]);
  });
}
