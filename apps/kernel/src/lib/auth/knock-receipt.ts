import { getClient } from '@imajin/db';
import { canonicalize, crypto as authCrypto, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import type { ContentHashFields, OperatorApprovalDecidedPayload } from '../notify/operator-approvals';

export interface KnockReceipt {
  payload: OperatorApprovalDecidedPayload;
  evidence: ContentHashFields;
  signature: string;
  senderPubkey: string;
}

export interface KnockReceiptInput {
  knockId: string;
  issuedAt: string;
  signature: string;
}

export function knockReceiptTranscript(input: Pick<KnockReceiptInput, 'knockId' | 'issuedAt'>): string {
  return canonicalize({ action: 'knock.receipt', knockId: input.knockId, issuedAt: input.issuedAt });
}

function parseReceiptInput(raw: unknown): KnockReceiptInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { knockId, issuedAt, signature } = raw as Record<string, unknown>;
  if (typeof knockId !== 'string' || !knockId || knockId.length > 200) return null;
  if (typeof issuedAt !== 'string' || issuedAt.length > 64) return null;
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return null;
  const age = Date.now() - Date.parse(issuedAt);
  if (!Number.isFinite(age) || age > SIGNED_MESSAGE_MAX_AGE || age < -FUTURE_TOLERANCE) return null;
  return { knockId, issuedAt, signature };
}

/** Escrow possession proves ownership without minting an identity or granting authority. */
export async function readKnockReceipt(raw: unknown): Promise<{ ok: true; receipt: KnockReceipt | null } | { ok: false }> {
  const input = parseReceiptInput(raw);
  if (!input) return { ok: false };
  const [knock] = await getClient().unsafe<{ public_key: string; agent_did: string; declared_target: string }[]>(
    'SELECT public_key, agent_did, declared_target FROM auth.agent_knocks WHERE id = $1', [input.knockId],
  );
  if (!knock || !/^[0-9a-f]{64}$/i.test(knock.public_key)
    || !authCrypto.verifySync(input.signature, knockReceiptTranscript(input), knock.public_key)) return { ok: false };
  const [row] = await getClient().unsafe<{
    proposal_id: string; source: string; kind: string; summary: string; keys_touched: string[];
    detail: Record<string, unknown>; decision: Omit<KnockReceipt, 'evidence'>;
  }[]>(`
    SELECT proposal_id, source, kind, summary, keys_touched, detail, decision FROM operator.approvals
    WHERE source = 'knock' AND kind = 'knock:request' AND status = 'applied'
      AND operator_did = $1 AND signer_did = $2 AND detail->>'knockId' = $3
      AND detail->>'principalDid' = $1 AND detail->>'requesterDid' = $2
    ORDER BY applied_at DESC, proposal_id DESC LIMIT 1
  `, [knock.declared_target, knock.agent_did, input.knockId]);
  if (!row?.decision) return { ok: true, receipt: null };
  const evidence: ContentHashFields = {
    proposalId: row.proposal_id, source: row.source, kind: row.kind, summary: row.summary,
    keysTouched: row.keys_touched, detail: row.detail,
  };
  return { ok: true, receipt: { ...row.decision, evidence } };
}
