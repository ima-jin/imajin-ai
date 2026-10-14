import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';
/**
 * POST /notify/api/internal/operator-approvals/applied — return-path hook
 * (#2059 task 4).
 *
 * The plugin calls this once the Gateway has actually applied an approved
 * so /jin can show execution status. Auth: vault-sourced internal Bearer key.
 *
 * Deliberately minimal per the issue's scope: no signature, no new bus
 * event, just the state transition. Idempotent and silent on a proposal
 * that isn't currently 'approved' (already applied, denied, or unknown) —
 * the plugin's own idempotency contract (#24: "a decision for an
 * already-applied/expired proposal is a no-op with a log line") means this
 * call may legitimately race or repeat.
 *
 * Body (JSON): { proposalId: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { markApplied } from '@/src/lib/notify/operator-approvals-service';

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authError = await requireInternalApiKey(request);
  if (authError) return authError;

  let body: { proposalId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { proposalId } = body;
  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    return NextResponse.json({ error: 'proposalId is required' }, { status: 400, headers: cors });
  }

  const result = await markApplied(proposalId);
  return NextResponse.json(result, { headers: cors });
}
