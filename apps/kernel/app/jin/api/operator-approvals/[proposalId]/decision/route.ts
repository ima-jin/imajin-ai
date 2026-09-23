/**
 * POST /jin/api/operator-approvals/:proposalId/decision — approve, reject,
 * or withdraw an operator approval proposal (#2059, generalized vocabulary
 * #2152).
 *
 * The load-bearing auth rule: this route requires `requireAuth` to resolve
 * the exact HUMAN operator identity — never `resolveActingDid`, never
 * `X-Acting-For` / `onBehalfOf`. `@jin` (the agent) proposing and `@jin`
 * approving must be impossible: an agent authenticated with its own DID and
 * `X-Acting-For: <operatorDid>` has `identity.id !== operatorDid`, so
 * {@link isOperatorIdentity} rejects it regardless of what it claims to act
 * for. A non-operator identity — including a genuinely different human —
 * gets 403 without ever learning whether `proposalId` exists.
 *
 * `decision` is the open, source-agnostic vocabulary (#2152): the kernel
 * never interprets it, only witnesses it and carries it (plus `source` +
 * `kind` from the stored proposal) through on `operator.approval.decided`.
 * An optional `mode` (e.g. 'allow-once') is likewise opaque — chosen by
 * whatever source-adapter interprets the decision downstream.
 *
 * Body (JSON): { decision: 'approve' | 'reject' | 'withdrawn', mode?: string, reason?: string,
 *   operatorSignature?: { keyId: string; alg: 'ed25519'; sig: string }, decidedAt?: string }
 *
 * `operatorSignature` + `decidedAt` (#2082): the operator's own
 * countersignature over `canonicalize({contentHash, decision, decidedAt})`,
 * produced client-side on /jin. `decidedAt` is REQUIRED whenever
 * `operatorSignature` is present (it's exactly what the client signed
 * over) and is verified for clock skew + against the signature in
 * `decideOperatorApproval`. Optional while `OPERATOR_COUNTERSIGN_REQUIRED`
 * is off; once that per-node flag is on, omitting it is rejected with 400.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { decideOperatorApproval } from '@/src/lib/notify/operator-approvals-service';
import { parseOperatorSignature } from '@/src/lib/notify/operator-countersign';
import { executeVaultApproval } from '@/src/lib/vault/approvals-execution';
import { executeAccessApproval } from '@/src/lib/access/approvals-execution';
import { executeGithubApproval, GITHUB_SOURCE } from '@/src/lib/github/approvals-execution';

const log = createLogger('kernel:operator-approvals:decision');

export const dynamic = 'force-dynamic';

const VALID_DECISIONS = new Set(['approve', 'reject', 'withdrawn']);
const MAX_MODE_LENGTH = 128;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

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

  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    // 403, not 404: authenticated but forbidden. Never reveal whether
    // proposalId exists to a caller who isn't the operator.
    return NextResponse.json({ error: 'Only the node operator may decide this proposal' }, { status: 403, headers: cors });
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
  const mode = typeof body.mode === 'string' ? body.mode : undefined;
  if (mode !== undefined && mode.length > MAX_MODE_LENGTH) {
    return NextResponse.json(
      { error: `mode must be at most ${MAX_MODE_LENGTH} chars` },
      { status: 400, headers: cors },
    );
  }

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
      operatorDid,
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
    log.error({ err: String(err), proposalId, operatorDid }, 'decideOperatorApproval failed');
    return NextResponse.json({ error: 'Failed to record decision' }, { status: 500, headers: cors });
  }
}
