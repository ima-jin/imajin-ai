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
 * Body (JSON): { decision: 'approve' | 'reject' | 'withdrawn', mode?: string, reason?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { decideOperatorApproval } from '@/src/lib/notify/operator-approvals-service';

const log = createLogger('kernel:operator-approvals:decision');

export const dynamic = 'force-dynamic';

const VALID_DECISIONS = new Set(['approve', 'reject', 'withdrawn']);
const MAX_MODE_LENGTH = 128;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
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

  try {
    const result = await decideOperatorApproval({
      proposalId,
      operatorDid,
      decision: decision as 'approve' | 'reject' | 'withdrawn',
      mode,
      reason,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json({ approval: result.card }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), proposalId, operatorDid }, 'decideOperatorApproval failed');
    return NextResponse.json({ error: 'Failed to record decision' }, { status: 500, headers: cors });
  }
}
