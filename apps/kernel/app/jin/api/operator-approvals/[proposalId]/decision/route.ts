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

const log = createLogger('kernel:operator-approvals:decision');

export const dynamic = 'force-dynamic';

const VALID_DECISIONS = new Set(['approve', 'reject', 'withdrawn']);
const MAX_MODE_LENGTH = 128;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * #2247: approving on the canvas IS the signing event for a vault:*
 * proposal (mint/grant/rotate/revoke). `decideOperatorApproval` itself
 * stays source-agnostic (#2152) — it only records the witnessed decision
 * — so the actual vault mutation runs here, right after, and ONLY for a
 * successful 'approve' on a vault-sourced proposal. A mutation failure is
 * reported back as `executionError` without un-recording the decision
 * itself, which is durable regardless of outcome. Extracted out of POST so
 * its cognitive complexity stays under the SonarCloud threshold.
 */
async function runVaultExecutionIfApplicable(
  proposalId: string,
  decision: string,
  card: Parameters<typeof executeVaultApproval>[0],
): Promise<string | undefined> {
  if (decision !== 'approve' || card.source !== 'vault') {
    return undefined;
  }
  const execution = await executeVaultApproval(card);
  if (execution.ok) {
    return undefined;
  }
  log.error({ proposalId, kind: card.kind, error: execution.error }, 'Vault proposal approved but execution failed');
  return execution.error;
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

    const executionError = await runVaultExecutionIfApplicable(proposalId, decision, result.card);

    return NextResponse.json(
      executionError ? { approval: result.card, executionError } : { approval: result.card },
      { headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err), proposalId, operatorDid }, 'decideOperatorApproval failed');
    return NextResponse.json({ error: 'Failed to record decision' }, { status: 500, headers: cors });
  }
}
