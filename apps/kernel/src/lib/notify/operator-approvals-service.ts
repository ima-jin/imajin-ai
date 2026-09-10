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
  OperatorApprovalDecidedPayload,
} from './operator-approvals';

const log = createLogger('kernel:operator-approvals');

export interface OperatorApprovalCard {
  proposalId: string;
  operatorDid: string;
  /** Open vocabulary namespace, e.g. 'system-agent', 'skill-workshop' (#2152). */
  source: string;
  /** '<source>:<subkind>', e.g. 'system-agent:restart' (#2152). */
  kind: string;
  summary: string;
  keysTouched: string[];
  /** Optional, bounded per-source structured detail (#2152). */
  detail: Record<string, unknown> | null;
  /** sha256 hex digest covering the payload including detail, when supplied (#2152). */
  contentHash: string | null;
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
    source: row.source,
    kind: row.kind,
    summary: row.summary,
    keysTouched: (row.keysTouched as string[] | null) ?? [],
    detail: (row.detail as Record<string, unknown> | null) ?? null,
    contentHash: row.contentHash ?? null,
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
  source: string;
  kind: string;
  summary: string;
  keysTouched: string[];
  detail: Record<string, unknown> | null;
  contentHash: string | null;
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
  const { proposalId, operatorDid, source, kind, summary, keysTouched, detail, contentHash, notificationId } = params;

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
    source,
    kind,
    summary,
    keysTouched,
    detail,
    contentHash,
    notificationId,
    status: 'pending',
  });

  log.info({ proposalId, operatorDid, source, kind }, 'operator approval requested');
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
  /** Opaque, source-adapter-chosen refinement of `decision` (e.g. 'allow-once') — kernel never interprets it (#2152). */
  mode?: string;
  reason?: string;
}

/** The status a proposal must be in for a given decision to be legal. */
function requiredStatusFor(decision: ApprovalDecision): OperatorApprovalRow['status'] {
  return decision === 'withdrawn' ? 'approved' : 'pending';
}

/** The status a proposal moves to once a given decision is recorded. */
function nextStatusFor(decision: ApprovalDecision): OperatorApprovalRow['status'] {
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'denied';
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
  const { proposalId, operatorDid, decision, mode, reason } = params;

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
    source: row.source,
    kind: row.kind,
    decision,
    ...(mode ? { mode } : {}),
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

/**
 * List every proposal ever addressed to `operatorDid`, newest first.
 * Optionally scoped to one `source` (#2152), e.g. the /jin panel's own
 * `?source=` filter — never a security boundary, just a view filter, since
 * every row here already belongs to this operator.
 */
export async function listApprovalsForOperator(
  operatorDid: string,
  options: { source?: string } = {},
): Promise<OperatorApprovalCard[]> {
  const conditions = [eq(operatorApprovals.operatorDid, operatorDid)];
  if (options.source) conditions.push(eq(operatorApprovals.source, options.source));

  const rows = await db
    .select()
    .from(operatorApprovals)
    .where(and(...conditions))
    .orderBy(desc(operatorApprovals.createdAt));
  return rows.map(toCard);
}
