/**
 * Operator approvals — lifecycle service (#2059).
 *
 * Backs the /jin confirm card: persists the proposal raised by
 * `POST /notify/api/send` (scope `operator.approval.requested`), and the
 * signed decision minted when the operator taps Approve/Deny/Withdraw.
 * Mirrors the node-signing pattern already established by the GitHub
 * confirm route (#1366/#1429) and the generic consent-request primitive
 * (#1817): the kernel signs the decision using its own signing identity,
 * witnessing the operator's explicit tap.
 */
import { and, desc, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import * as bus from '@imajin/bus';
import { db, operatorApprovals, type OperatorApprovalRow } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type {
  ApprovalDecision,
  ApprovalProposalKind,
  OperatorApprovalDecidedPayload,
} from './operator-approvals';

const log = createLogger('kernel:operator-approvals');

export interface OperatorApprovalCard {
  proposalId: string;
  operatorDid: string;
  kind: ApprovalProposalKind;
  summary: string;
  keysTouched: string[];
  status: OperatorApprovalRow['status'];
  decision: OperatorApprovalDecidedPayload | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toCard(row: OperatorApprovalRow): OperatorApprovalCard {
  const decisionRecord = row.decision as { payload?: OperatorApprovalDecidedPayload } | null;
  return {
    proposalId: row.proposalId,
    operatorDid: row.operatorDid,
    kind: row.kind as ApprovalProposalKind,
    summary: row.summary,
    keysTouched: (row.keysTouched as string[] | null) ?? [],
    status: row.status,
    decision: decisionRecord?.payload ?? null,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface RecordApprovalRequestedParams {
  proposalId: string;
  operatorDid: string;
  kind: ApprovalProposalKind;
  summary: string;
  keysTouched: string[];
  notificationId: string;
}

/**
 * Persist a freshly-requested proposal. Upsert on `proposalId` so a plugin
 * retry (e.g. after a network blip on its own send) never fails with a
 * duplicate-key error — the row's content is refreshed but the state
 * machine, once a decision exists, must not silently rewind (a retry that
 * arrives after the operator already decided leaves the decision alone).
 */
export async function recordApprovalRequested(params: RecordApprovalRequestedParams): Promise<void> {
  const { proposalId, operatorDid, kind, summary, keysTouched, notificationId } = params;

  const [existing] = await db
    .select({ status: operatorApprovals.status })
    .from(operatorApprovals)
    .where(eq(operatorApprovals.proposalId, proposalId))
    .limit(1);

  if (existing) {
    log.info({ proposalId, currentStatus: existing.status }, 'operator approval already recorded — skipping re-insert');
    return;
  }

  await db.insert(operatorApprovals).values({
    proposalId,
    operatorDid,
    kind,
    summary,
    keysTouched,
    notificationId,
    status: 'pending',
  });

  log.info({ proposalId, operatorDid, kind }, 'operator approval requested');
}

async function loadApproval(proposalId: string): Promise<OperatorApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(operatorApprovals)
    .where(eq(operatorApprovals.proposalId, proposalId))
    .limit(1);
  return row;
}

export type DecideOperatorApprovalResult =
  | { ok: true; card: OperatorApprovalCard }
  | { ok: false; error: string; status: number };

export interface DecideOperatorApprovalParams {
  proposalId: string;
  operatorDid: string;
  decision: ApprovalDecision;
  reason?: string;
}

/** The status a proposal must be in for a given decision to be legal. */
function requiredStatusFor(decision: ApprovalDecision): OperatorApprovalRow['status'] {
  return decision === 'withdrawn' ? 'approved' : 'pending';
}

/** The status a proposal moves to once a given decision is recorded. */
function nextStatusFor(decision: ApprovalDecision): OperatorApprovalRow['status'] {
  if (decision === 'approve') return 'approved';
  if (decision === 'deny') return 'denied';
  return 'withdrawn';
}

/**
 * Record the operator's decision: sign a kernel-witnessed attestation,
 * advance the proposal's state machine, and publish `operator.approval.decided`
 * for the plugin to consume. Fail-closed: a proposal not in the state this
 * decision requires is rejected before any signature is produced — in
 * particular `withdrawn` is only legal from `approved` ("pending-apply"),
 * never once `applied`.
 */
export async function decideOperatorApproval(
  params: DecideOperatorApprovalParams,
): Promise<DecideOperatorApprovalResult> {
  const { proposalId, operatorDid, decision, reason } = params;

  const row = await loadApproval(proposalId);
  if (!row) {
    return { ok: false, error: 'Proposal not found', status: 404 };
  }
  if (row.operatorDid !== operatorDid) {
    return { ok: false, error: 'Proposal not found', status: 404 };
  }

  const requiredStatus = requiredStatusFor(decision);
  if (row.status !== requiredStatus) {
    return {
      ok: false,
      error: `Proposal is not awaiting this decision (status: ${row.status})`,
      status: 409,
    };
  }

  const identity = getNodeSigningIdentity();
  const decidedAt = new Date().toISOString();
  const payload: OperatorApprovalDecidedPayload = {
    proposalId,
    decision,
    decidedBy: operatorDid,
    decidedAt,
    ...(reason ? { reason } : {}),
  };
  const signature = authCrypto.signSync(canonicalize(payload), identity.privateKeyHex);
  const signedDecision = { payload, signature, senderPubkey: identity.senderPubkey };

  const nextStatus = nextStatusFor(decision);
  const now = new Date();
  await db
    .update(operatorApprovals)
    .set({ status: nextStatus, decision: signedDecision, updatedAt: now })
    .where(and(eq(operatorApprovals.proposalId, proposalId), eq(operatorApprovals.status, requiredStatus)));

  try {
    await bus.publish('operator.approval.decided', {
      issuer: operatorDid,
      subject: operatorDid,
      scope: 'operator',
      payload,
    });
  } catch (err) {
    log.error({ err: String(err), proposalId }, 'operator.approval.decided publish failed (non-fatal)');
  }

  log.info({ proposalId, operatorDid, decision }, 'operator approval decided');

  const fresh = await loadApproval(proposalId);
  return { ok: true, card: toCard(fresh ?? { ...row, status: nextStatus, decision: signedDecision, updatedAt: now }) };
}

/**
 * Record that the plugin confirmed the Gateway applied an approved
 * proposal. Minimal by design (#2059 task 4): no signature, no new event —
 * just the state /jin needs to show "applied" instead of "approved".
 * Idempotent: applying an already-applied proposal is a no-op success, and
 * a proposal not currently `approved` is left untouched.
 */
export async function markApplied(proposalId: string): Promise<{ ok: boolean }> {
  const row = await loadApproval(proposalId);
  if (!row) return { ok: false };
  if (row.status === 'applied') return { ok: true };
  if (row.status !== 'approved') return { ok: false };

  await db
    .update(operatorApprovals)
    .set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(operatorApprovals.proposalId, proposalId), eq(operatorApprovals.status, 'approved')));

  log.info({ proposalId }, 'operator approval applied');
  return { ok: true };
}

/** List every proposal ever addressed to `operatorDid`, newest first. */
export async function listApprovalsForOperator(operatorDid: string): Promise<OperatorApprovalCard[]> {
  const rows = await db
    .select()
    .from(operatorApprovals)
    .where(eq(operatorApprovals.operatorDid, operatorDid))
    .orderBy(desc(operatorApprovals.createdAt));
  return rows.map(toCard);
}
