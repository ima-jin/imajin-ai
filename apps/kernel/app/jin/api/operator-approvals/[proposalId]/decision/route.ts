/**
 * POST /jin/api/operator-approvals/:proposalId/decision — approve, reject,
 * or withdraw an operator approval proposal (#2059, generalized vocabulary
 * #2152).
 *
 * The load-bearing auth rule: this route decides as the REAL authenticated
 * session DID — never `resolveActingDid`, never `X-Acting-For` /
 * `onBehalfOf` — and that DID must be the one the proposal is ADDRESSED TO
 * (#2723). `operator.approvals.operator_did` means "whose Inbox": the
 * connector owner for a connector proposal (github …), the node operator for
 * every node-level kind. So the owner decides their own connector
 * proposal, the node operator decides node-level kinds, and the operator
 * gets 403 on someone else's connector proposal — the service enforces it
 * (see `resolveApprovalAddressee`). `@jin` (the agent) proposing and `@jin`
 * approving must stay impossible: an agent authenticated with its own DID
 * and `X-Acting-For: <ownerDid>` is refused by {@link inboxDidFor} (it has
 * no Inbox) regardless of what it claims to act for.
 *
 * #2359 closed the other half of that rule: act-as of ANY shape is refused
 * here before the operator comparison even runs ({@link actAsRefusal}, 403
 * `act_as_not_permitted`). `isOperatorIdentity` alone only ever excluded
 * `actingFor`, so the operator's own session carrying the
 * IdentitySwitcher's `x-acting-as: <group DID>` cookie still satisfied
 * `identity.id === operatorDid` and countersigned writes while wearing
 * somebody else's identity. This rail is self-only — the real session DID
 * is the party on the hook — so a borrowed one never reaches the signing
 * event. Listing stays readable under act-as (`GET /jin/api/operator-
 * approvals`); only deciding is refused.
 *
 * `decision` is the open, source-agnostic vocabulary (#2152): the kernel
 * never interprets it, only witnesses it and carries it (plus `source` +
 * `kind` from the stored proposal) through on `operator.approval.decided`.
 * An optional `mode` is the operator's chosen option (#2693) — a
 * decision-card option letter, exec `allow-once`/`deny`, or a github TTL.
 * It is NOT opaque: `decideOperatorApproval` refuses (400) any `mode` the
 * approval's kind doesn't offer (see `operator-decision-modes.ts`), and the
 * operator countersignature below covers it.
 *
 * Body (JSON): { decision: 'approve' | 'reject' | 'withdrawn', mode?: string, reason?: string,
 *   operatorSignature?: { keyId: string; alg: 'ed25519'; sig: string }, decidedAt?: string }
 *
 * `operatorSignature` + `decidedAt` (#2082): the operator's own
 * countersignature over `canonicalize({contentHash, decision, decidedAt})`
 * — plus `mode` whenever the decision carries one (#2693: a `mode` altered
 * after signing, or added to a signature that didn't cover it, fails
 * verification with 400) — produced client-side on /jin. `decidedAt` is REQUIRED whenever
 * `operatorSignature` is present (it's exactly what the client signed
 * over) and is verified for clock skew + against the signature in
 * `decideOperatorApproval`. Optional while `OPERATOR_COUNTERSIGN_REQUIRED`
 * is off; once that per-node flag is on, omitting it is rejected with 400.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { inboxDidFor } from '@/src/lib/notify/approval-addressing';
import { actAsRefusal } from '@/src/lib/notify/act-as-guard';
import { decideOperatorApproval } from '@/src/lib/notify/operator-approvals-service';
import { parseOperatorSignature } from '@/src/lib/notify/operator-countersign';
import { executeVaultApproval } from '@/src/lib/vault/approvals-execution';
import { executeAccessApproval } from '@/src/lib/access/approvals-execution';
import { executeGithubApproval, GITHUB_SOURCE } from '@/src/lib/github/approvals-execution';
import { executeAppsProvisionApproval } from '@/src/lib/apps/approvals-execution';
import { APPS_SERVICE_SCOPES_KIND } from '@/src/lib/apps/service-scopes-kind';
import { executeAppsServiceScopesApproval } from '@/src/lib/apps/service-scopes';

const log = createLogger('kernel:operator-approvals:decision');

export const dynamic = 'force-dynamic';

const VALID_DECISIONS = new Set(['approve', 'reject', 'withdrawn']);
const MAX_MODE_LENGTH = 128;

/**
 * #2247/#2252: approving on the canvas IS the signing event for a vault:*
 * or access:* proposal. `decideOperatorApproval` itself stays
 * source-agnostic (#2152) — it only records the witnessed decision — so
 * the actual mutation runs here, right after, and ONLY for a successful
 * 'approve' on a vault- or access-sourced proposal. A mutation failure is
 * reported back as `executionError` without un-recording the decision
 * itself, which is durable regardless of outcome. `data` (#2252) carries a
 * ONE-TIME reveal payload back to the caller — currently only the freshly
 * minted delegate-grant bearer plaintext; never persisted anywhere past
 * this single response. Extracted out of POST so its cognitive complexity
 * stays under the SonarCloud threshold.
 */
interface ExecutionOutcome {
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * `apps` source: `apps:service-scopes` (#2711) and `apps:provision` (#2375) share the source but run
 * different, each countersign-gated, executors. Extracted to keep the dispatcher's complexity down.
 */
async function runAppsExecution(
  proposalId: string,
  card: Parameters<typeof executeVaultApproval>[0],
): Promise<ExecutionOutcome> {
  const isServiceScopes = card.kind === APPS_SERVICE_SCOPES_KIND;
  const execution = isServiceScopes
    ? await executeAppsServiceScopesApproval(card)
    : await executeAppsProvisionApproval(card);
  if (execution.ok) return { data: { ...execution.data } };
  log.error(
    { proposalId, kind: card.kind, error: execution.error },
    isServiceScopes ? 'Service-scopes proposal approved but execution failed' : 'Apps proposal approved but execution failed',
  );
  return { error: execution.error };
}

async function runProposalExecutionIfApplicable(
  proposalId: string,
  decision: string,
  card: Parameters<typeof executeVaultApproval>[0],
  mode: string | undefined,
): Promise<ExecutionOutcome> {
  // #2293: github's ledger must be kept in sync on EVERY decision (reject
  // and withdrawn retire the linked ledger row too), unlike vault/access
  // which only ever act on 'approve'.
  if (card.source === GITHUB_SOURCE) {
    const execution = await executeGithubApproval(card, decision as 'approve' | 'reject' | 'withdrawn', mode);
    if (execution.ok) return {};
    log.error({ proposalId, kind: card.kind, error: execution.error }, 'GitHub proposal decided but ledger sync failed');
    return { error: execution.error };
  }

  if (decision !== 'approve') {
    return {};
  }
  if (card.source === 'vault') {
    const execution = await executeVaultApproval(card);
    if (execution.ok) return {};
    log.error({ proposalId, kind: card.kind, error: execution.error }, 'Vault proposal approved but execution failed');
    return { error: execution.error };
  }
  if (card.source === 'access') {
    const execution = await executeAccessApproval(card);
    if (execution.ok) return { data: { ...execution.data } };
    log.error({ proposalId, kind: card.kind, error: execution.error }, 'Access proposal approved but execution failed');
    return { error: execution.error };
  }
  if (card.source === 'apps') {
    return runAppsExecution(proposalId, card);
  }
  return {};
}

/** Assembles the decision response body, folding in `executionError`/`data` only when present. Extracted purely to keep POST's own cognitive complexity down. */
function buildDecisionResponseBody(
  card: Parameters<typeof executeVaultApproval>[0],
  outcome: ExecutionOutcome,
): Record<string, unknown> {
  const body: Record<string, unknown> = { approval: card };
  if (outcome.error) body.executionError = outcome.error;
  if (outcome.data) body.data = outcome.data;
  return body;
}

/**
 * Shape-check the optional `mode` (#2693). Absent → undefined; anything
 * that isn't a non-empty string within the length bound is refused here —
 * an empty or non-string `mode` is never a chosen option, and silently
 * dropping it would leave it out of what the operator signed. Whether the
 * string is a mode this approval's kind OFFERS is `decideOperatorApproval`'s
 * check (it needs the stored card).
 */
function parseMode(raw: unknown): { ok: true; mode: string | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, mode: undefined };
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, error: 'mode must be omitted or a non-empty string' };
  if (raw.length > MAX_MODE_LENGTH) return { ok: false, error: `mode must be at most ${MAX_MODE_LENGTH} chars` };
  return { ok: true, mode: raw };
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ proposalId: string }> },
) {
  const { proposalId } = await props.params;
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  // #2359: self-only, checked first. A borrowed identity is refused for
  // being borrowed and is never compared against the proposal's owner, so
  // this refusal reveals nothing about whether `proposalId` exists either.
  const borrowedIdentityRefusal = actAsRefusal(authResult.identity, cors);
  if (borrowedIdentityRefusal) return borrowedIdentityRefusal;

  // A delegated agent has no Inbox and may not decide. Whether the session
  // DID is the one this proposal is addressed to is the service's call (403).
  const deciderDid = inboxDidFor(authResult.identity);
  if (!deciderDid) {
    return NextResponse.json({ error: 'Only the identity a proposal is addressed to may decide it' }, { status: 403, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON with a decision field ('approve' | 'reject' | 'withdrawn')" },
      { status: 400, headers: cors },
    );
  }

  const decision = body.decision;
  if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision)) {
    return NextResponse.json(
      { error: "decision must be 'approve', 'reject', or 'withdrawn'" },
      { status: 400, headers: cors },
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  const modeResult = parseMode(body.mode);
  if (!modeResult.ok) {
    return NextResponse.json({ error: modeResult.error }, { status: 400, headers: cors });
  }
  const { mode } = modeResult;

  // #2082: shape-validate the optional operator countersignature here;
  // the service does the (async, DB-backed) cryptographic verification.
  const operatorSignatureResult = parseOperatorSignature(body.operatorSignature);
  if (!operatorSignatureResult.ok) {
    return NextResponse.json({ error: operatorSignatureResult.error }, { status: 400, headers: cors });
  }
  const decidedAt = typeof body.decidedAt === 'string' ? body.decidedAt : undefined;
  if (operatorSignatureResult.value && !decidedAt) {
    return NextResponse.json(
      { error: 'decidedAt is required when operatorSignature is present' },
      { status: 400, headers: cors },
    );
  }

  try {
    const result = await decideOperatorApproval({
      proposalId,
      operatorDid: deciderDid,
      decision: decision as 'approve' | 'reject' | 'withdrawn',
      mode,
      reason,
      operatorSignature: operatorSignatureResult.value,
      decidedAt,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }

    const outcome = await runProposalExecutionIfApplicable(proposalId, decision, result.card, mode);

    return NextResponse.json(buildDecisionResponseBody(result.card, outcome), { headers: cors });
  } catch (err) {
    log.error({ err: String(err), proposalId, deciderDid }, 'decideOperatorApproval failed');
    return NextResponse.json({ error: 'Failed to record decision' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
