/**
 * GitHub proposal execution bridge (#2293) — folds the pre-#2059 GitHub
 * confirm rail (`/github/api/confirm/:proposalId`) into the generic
 * `operator.approvals` rail (#2059/#2152) every other kind already rides.
 *
 * The human-facing decision (approve/reject/withdraw a GitHub write) now
 * goes through the SAME `POST /jin/api/operator-approvals/:id/decision`
 * route as vault/access/skill-workshop/gateway-exec. This module is what
 * turns that witnessed decision into GitHub-specific effects:
 *
 *   - The connector's write-gate ledger (`github.action_proposals` —
 *     UNCHANGED table/shape, see `../github/connector.ts`) is kept in sync:
 *     approve -> 'approved' (+ approvedUntil + ownerAuthorization), reject
 *     -> 'denied', withdrawn -> 'expired' (the ledger has no 'withdrawn'
 *     state of its own; 'expired' is the correct "no longer live" terminal
 *     for a window revoked early). `connector.ts`'s live-grant/rate-limit
 *     logic reads this ledger completely unchanged.
 *   - The operator-approvals row's own `outcome` records the same
 *     `approvedUntil`/`ownerAuthorization` for card display, mirroring the
 *     precedent #2221 set (`outcome` is where post-decision, kind-specific
 *     data belongs — see `../notify/exec-command-approvals.ts`).
 *   - The legacy `action.approved`/`action.denied` bus events are preserved
 *     byte-compatible with the old confirm route, since telemetry
 *     (`../kernel/connector-telemetry.ts`) and any attestation reactor
 *     configured on them are untouched by this fold.
 *
 * Unlike vault/access (`../vault/approvals-execution.ts`,
 * `../access/approvals-execution.ts`), GitHub does NOT unconditionally
 * require an operator countersignature — the issue only asks that GitHub
 * "goes through the same decide route... same operator countersign", i.e.
 * respect the existing per-node `OPERATOR_COUNTERSIGN_REQUIRED` flag like
 * every other kind on the generic rail, not a GitHub-specific hard gate.
 *
 * Called by the decision route for EVERY decision on a `source: 'github'`
 * card (not just 'approve' — contrast vault/access, which are only
 * consulted on 'approve') since reject/withdraw both need to retire the
 * linked ledger row.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { db, githubActionProposals, operatorApprovals } from '@/src/db';
import { getNodeSigningIdentity } from '../vault/sealing';
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';

const log = createLogger('kernel:github:approvals-execution');

/** The open-vocabulary source this kind is filed under (#2152). */
export const GITHUB_SOURCE = 'github';

/** Namespaced kinds — one per write-gate risk tier, NOT per tool (#2293 DECISION FOR RYAN: preserves the existing tier-shared approval-window semantics; the exact tool lives in `detail.tool`). */
export const GITHUB_APPEND_KIND = 'github:append';
export const GITHUB_MUTATE_KIND = 'github:mutate';
const GITHUB_KINDS = new Set([GITHUB_APPEND_KIND, GITHUB_MUTATE_KIND]);

export type GithubTtlMode = 'single' | '5m' | '24h';
const TTL_MODES = new Set<GithubTtlMode>(['single', '5m', '24h']);

export interface GithubExecutionResult {
  ok: boolean;
  error?: string;
}

/** Validates the optional TTL `mode` a github:* approve decision may carry — defaults to 'single', same default the old confirm route used. */
function resolveGithubTtlMode(mode: string | undefined): { ok: true; mode: GithubTtlMode } | { ok: false; error: string } {
  if (mode === undefined) return { ok: true, mode: 'single' };
  if (TTL_MODES.has(mode as GithubTtlMode)) return { ok: true, mode: mode as GithubTtlMode };
  return { ok: false, error: `mode must be one of 'single', '5m', '24h' for a github:* approve decision (got '${mode}')` };
}

/** Mirrors the old `/github/api/confirm/:proposalId` route's TTL -> expiry math exactly. */
function resolveApprovedUntil(mode: GithubTtlMode): Date | null {
  if (mode === 'single') return null;
  const ms = mode === '5m' ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

interface GithubDetail {
  ownerDid: string;
  agentDid: string | null;
  tool: string;
  target: string;
  argsSummary: string;
}

function readGithubDetail(card: OperatorApprovalCard): GithubDetail | null {
  const detail = card.detail;
  if (!detail || typeof detail.ownerDid !== 'string' || typeof detail.tool !== 'string' || typeof detail.target !== 'string' || typeof detail.argsSummary !== 'string') {
    return null;
  }
  return {
    ownerDid: detail.ownerDid,
    agentDid: typeof detail.agentDid === 'string' ? detail.agentDid : null,
    tool: detail.tool,
    target: detail.target,
    argsSummary: detail.argsSummary,
  };
}

/** Sign the owner authorization — byte-identical crypto to the retired `/github/api/confirm/:proposalId` POST route. */
function signOwnerAuthorization(proposalId: string, detail: GithubDetail, mode: GithubTtlMode) {
  const identity = getNodeSigningIdentity();
  const ts = new Date().toISOString();
  const authPayload = {
    proposalId,
    ownerDid: detail.ownerDid,
    tool: detail.tool,
    target: detail.target,
    ttl: mode,
    ts,
  };
  const argsDigest = createHash('sha256').update(detail.argsSummary).digest('hex');
  const signingPayload = { ...authPayload, argsDigest };
  const signature = authCrypto.signSync(canonicalize(signingPayload), identity.privateKeyHex);
  return { payload: signingPayload, signature, senderPubkey: identity.senderPubkey };
}

/** Best-effort sync of the operator-approvals row's `outcome` — never throws; a failure here is logged, not fatal (matches every other non-fatal bus-publish convention in this codebase). */
async function attachGithubOutcome(proposalId: string, outcome: Record<string, unknown>): Promise<void> {
  try {
    await db
      .update(operatorApprovals)
      .set({ outcome, updatedAt: new Date() })
      .where(eq(operatorApprovals.proposalId, proposalId));
  } catch (err) {
    log.error({ err: String(err), proposalId }, 'failed to attach github outcome to operator-approvals row (non-fatal)');
  }
}

async function executeApprove(card: OperatorApprovalCard, detail: GithubDetail, mode: string | undefined): Promise<GithubExecutionResult> {
  const modeResult = resolveGithubTtlMode(mode);
  if (!modeResult.ok) return { ok: false, error: modeResult.error };

  const approvedUntil = resolveApprovedUntil(modeResult.mode);
  const ownerAuthorization = signOwnerAuthorization(card.proposalId, detail, modeResult.mode);

  await db
    .update(githubActionProposals)
    .set({
      status: 'approved',
      approvedUntil,
      ownerAuthorization,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubActionProposals.id, card.proposalId),
        eq(githubActionProposals.ownerDid, detail.ownerDid),
      ),
    );

  await attachGithubOutcome(card.proposalId, {
    approvedUntil: approvedUntil ? approvedUntil.toISOString() : null,
    ownerAuthorization,
  });

  try {
    await bus.publish('action.approved', {
      issuer: detail.ownerDid,
      subject: detail.ownerDid,
      scope: 'github',
      payload: {
        proposalId: card.proposalId,
        ownerDid: detail.ownerDid,
        tool: detail.tool,
        target: detail.target,
        approvedUntil: approvedUntil ? approvedUntil.toISOString() : null,
        ownerAuthorization,
        context_id: card.proposalId,
        context_type: 'github' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId }, 'action.approved publish failed (non-fatal)');
  }

  log.info({ proposalId: card.proposalId, ownerDid: detail.ownerDid, tool: detail.tool, mode: modeResult.mode }, 'github proposal approved');
  return { ok: true };
}

async function executeReject(card: OperatorApprovalCard, detail: GithubDetail): Promise<GithubExecutionResult> {
  await db
    .update(githubActionProposals)
    .set({ status: 'denied', updatedAt: new Date() })
    .where(
      and(
        eq(githubActionProposals.id, card.proposalId),
        eq(githubActionProposals.ownerDid, detail.ownerDid),
      ),
    );

  try {
    await bus.publish('action.denied', {
      issuer: detail.ownerDid,
      subject: detail.ownerDid,
      scope: 'github',
      payload: {
        proposalId: card.proposalId,
        ownerDid: detail.ownerDid,
        tool: detail.tool,
        target: detail.target,
        context_id: card.proposalId,
        context_type: 'github' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId }, 'action.denied publish failed (non-fatal)');
  }

  log.info({ proposalId: card.proposalId, ownerDid: detail.ownerDid, tool: detail.tool }, 'github proposal denied');
  return { ok: true };
}

/** Withdraw = revoke a live window early. The ledger has no 'withdrawn' state; 'expired' is the correct "no longer live" terminal. */
async function executeWithdraw(card: OperatorApprovalCard, detail: GithubDetail): Promise<GithubExecutionResult> {
  await db
    .update(githubActionProposals)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(githubActionProposals.id, card.proposalId),
        eq(githubActionProposals.ownerDid, detail.ownerDid),
      ),
    );

  log.info({ proposalId: card.proposalId, ownerDid: detail.ownerDid }, 'github proposal window withdrawn');
  return { ok: true };
}

/**
 * Execute the ledger-sync behind a decided `source: 'github'` proposal.
 * Called by the decision route for every decision on a github card
 * (approve/reject/withdrawn) — never throws, every outcome is
 * `{ ok, error? }` matching the vault/access execution contract.
 */
export async function executeGithubApproval(
  card: OperatorApprovalCard,
  decision: 'approve' | 'reject' | 'withdrawn',
  mode: string | undefined,
): Promise<GithubExecutionResult> {
  if (!GITHUB_KINDS.has(card.kind)) {
    return { ok: false, error: `Unrecognized github proposal kind '${card.kind}'` };
  }
  const detail = readGithubDetail(card);
  if (!detail) {
    return { ok: false, error: `github:* proposal '${card.proposalId}' is missing required detail fields` };
  }

  try {
    if (decision === 'approve') return await executeApprove(card, detail, mode);
    if (decision === 'reject') return await executeReject(card, detail);
    return await executeWithdraw(card, detail);
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId, kind: card.kind, decision }, 'github proposal execution failed');
    return { ok: false, error: 'GitHub proposal execution failed' };
  }
}
