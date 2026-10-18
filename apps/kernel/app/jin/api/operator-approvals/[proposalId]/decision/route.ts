/**
 * Shared Inbox decision rail. Ordinary kinds remain self-only. Reach/knock
 * allow the principal or a live membership-verified act-as owner/admin;
 * the real human actor always signs and receives decidedBy attribution.
 * Reach decisions require approve + reply/accept/decline/block and a fresh
 * countersignature over contentHash, decision, decidedAt, mode and (only for
 * reply) replyMessage. The service commits domain actions atomically.
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
import { APPS_FEATURED_KIND } from '@/src/lib/apps/featured-kind';
import { executeAppsFeaturedApproval } from '@/src/lib/apps/featured';
import { executeAppSecretsApproval } from '@/src/lib/apps/secrets-operator';
import { isAppSecretsKind } from '@/src/lib/apps/secrets-kind';
import { reachActAsPrincipal } from '@/src/lib/notify/reach-approval-authority';

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
  let execution;
  if (card.kind === APPS_SERVICE_SCOPES_KIND) {
    execution = await executeAppsServiceScopesApproval(card);
  } else if (card.kind === APPS_FEATURED_KIND) {
    execution = await executeAppsFeaturedApproval(card);
  } else if (isAppSecretsKind(card.kind)) {
    execution = await executeAppSecretsApproval(card);
  } else if (card.kind === 'apps:provision') {
    execution = await executeAppsProvisionApproval(card);
  } else {
    return { error: `Unrecognized apps proposal kind '${card.kind}'` };
  }
  if (execution.ok) return { data: { ...execution.data } };
  log.error(
    { proposalId, kind: card.kind, error: execution.error },
    'Apps proposal approved but execution failed',
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

function validReplyShape(raw: unknown): boolean {
  return raw === undefined || (typeof raw === 'string' && raw.length <= 16_000);
}

function decisionFailure(error: { error: string; status: number }, borrowed: NextResponse | null, cors: HeadersInit) {
  if (borrowed && error.status === 403) return borrowed;
  return NextResponse.json({ error: error.error }, { status: error.status, headers: cors });
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

  // Ordinary borrowed sessions fail before proposal lookup. Only a verified
  // human admin reaches the service, which limits the exception to Reach cards.
  const borrowedIdentityRefusal = actAsRefusal(authResult.identity, cors);
  if (borrowedIdentityRefusal && !await reachActAsPrincipal(authResult.identity)) return borrowedIdentityRefusal;

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
  if (!validReplyShape(body.replyMessage)) {
    return NextResponse.json({ error: 'replyMessage must be a string of at most 16000 characters' }, { status: 400, headers: cors });
  }
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
      identity: authResult.identity,
      replyMessage: body.replyMessage as string | undefined,
      decision: decision as 'approve' | 'reject' | 'withdrawn',
      mode,
      reason,
      operatorSignature: operatorSignatureResult.value,
      decidedAt,
      sessionCommand: body.sessionCommand,
    });
    if (!result.ok) {
      return decisionFailure(result, borrowedIdentityRefusal, cors);
    }

    const outcome = await runProposalExecutionIfApplicable(proposalId, decision, result.card, mode);

    return NextResponse.json(buildDecisionResponseBody(result.card, outcome), { headers: cors });
  } catch (err) {
    log.error({ err: String(err), proposalId, deciderDid }, 'decideOperatorApproval failed');
    return NextResponse.json({ error: 'Failed to record decision' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
