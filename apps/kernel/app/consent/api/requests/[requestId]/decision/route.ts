/**
 * POST /consent/api/requests/:requestId/decision — approve or reject a
 * pending consent request (#1817).
 *
 * The canvas tap on /jin IS the signing event: session-authenticated, and
 * the caller must be the exact approver DID the request was addressed to.
 * Mints a kernel-witnessed `approval.decision` attestation referencing the
 * request and publishes it back on the bus for the requesting system.
 *
 * Body (JSON): { decision: 'approve' | 'reject' }
 *
 * Response: { request: ConsentRequestCard, decision: ConsentDecisionAttestation }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { decideConsentRequest } from '@/src/lib/consent-requests/consent-requests';

const log = createLogger('kernel:consent:decision');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ requestId: string }> },
) {
  const params = await props.params;
  const cors = corsHeaders(request);
  const { requestId } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const approverDid = resolveActingDid(authResult.identity);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON with a decision field ('approve' | 'reject')" },
      { status: 400, headers: cors },
    );
  }

  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400, headers: cors });
  }

  try {
    const result = await decideConsentRequest({ requestId, approverDid, decision });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json({ request: result.request, decision: result.decision }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), requestId, approverDid }, 'decideConsentRequest failed');
    return NextResponse.json({ error: 'Failed to record decision' }, { status: 500, headers: cors });
  }
}
