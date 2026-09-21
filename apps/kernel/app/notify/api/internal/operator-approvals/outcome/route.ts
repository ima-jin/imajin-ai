/**
 * POST /notify/api/internal/operator-approvals/outcome — post-exec outcome
 * follow-up (#2221 scope item 4).
 *
 * The gateway-exec bridge calls this once the OpenClaw gateway reports an
 * exec-finished event for a command it ran after an `allow-once` decision,
 * so /jin can show wish -> grant -> what actually ran. Guarded by the same
 * webhook secret every other machine-to-kernel notify write uses
 * (`NOTIFY_WEBHOOK_SECRET`, see `POST /notify/api/send` and the sibling
 * `.../operator-approvals/applied` route) — no new secret.
 *
 * Scoped to exec.command: attaching an outcome to any other kind's
 * proposal is rejected with 400, since no other kind has "the command
 * finished running" semantics today.
 *
 * Body (JSON): { proposalId: string, exitCode: number, durationMs: number, outputHash: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { attachApprovalOutcome } from '@/src/lib/notify/operator-approvals-service';

const MAX_OUTPUT_HASH_LENGTH = 128;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface OutcomeRequestBody {
  proposalId?: unknown;
  exitCode?: unknown;
  durationMs?: unknown;
  outputHash?: unknown;
}

/** Validates the outcome body shape. Extracted so POST's cognitive complexity stays low. */
function validateOutcomeBody(
  body: OutcomeRequestBody,
): { ok: true; proposalId: string; exitCode: number; durationMs: number; outputHash: string } | { ok: false; error: string } {
  const { proposalId, exitCode, durationMs, outputHash } = body;

  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    return { ok: false, error: 'proposalId is required' };
  }
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    return { ok: false, error: 'exitCode is required and must be an integer' };
  }
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return { ok: false, error: 'durationMs is required and must be a non-negative number' };
  }
  if (typeof outputHash !== 'string' || outputHash.length === 0 || outputHash.length > MAX_OUTPUT_HASH_LENGTH) {
    return { ok: false, error: `outputHash is required (max ${MAX_OUTPUT_HASH_LENGTH} chars)` };
  }

  return { ok: true, proposalId, exitCode, durationMs, outputHash };
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: OutcomeRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const validation = validateOutcomeBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }

  const { proposalId, exitCode, durationMs, outputHash } = validation;
  const result = await attachApprovalOutcome(proposalId, { exitCode, durationMs, outputHash });
  if (!result.ok) {
    const status = result.error === 'Proposal not found' ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status, headers: cors });
  }
  return NextResponse.json(result, { headers: cors });
}
