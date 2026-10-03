import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { agentCardUrl } from '@imajin/auth';
import { resolveCallerIdentity, isCallerIdentityError } from '@/src/lib/auth/require-caller-did';
import { resolveServingAgents } from '@/src/lib/auth/agent-service';
import { createLogger } from '@imajin/logger';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /auth/api/identity/:did/agents
 *
 * The principal's serving agents and their live harness connection
 * (#2407, RFC-31 v2 Phase 1). `agents[]` are the `actor/agent` DIDs bound to
 * `:did` via `serviceOf`; `connection.state` is whether that agent DID
 * currently holds an authenticated WebSocket to the kernel
 * (`connected` | `disconnected` | `unknown` — `unknown` means the check
 * itself failed, never "offline").
 *
 * Read-only, and no new authority. Only the principal itself may read it: the
 * caller's own session DID, or the group DID it operates as via `X-Acting-As`.
 * `X-Acting-For` is refused outright, as on `POST /auth/api/agents/provision`
 * — an agent acting under delegation cannot enumerate its principal's agents,
 * and an `actor/agent` session cannot read any principal's list but its own.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ did: string }> }) {
  const cors = corsHeaders(request);

  const auth = await resolveCallerIdentity(request);
  if (isCallerIdentityError(auth)) {
    return auth.errorResponse;
  }
  const { identity, callerDid } = auth;

  if (identity.actingFor) {
    return NextResponse.json(
      { error: 'Serving agents are visible to the principal directly, not while acting under agent delegation', onboarding: agentCardUrl() },
      { status: 403, headers: cors },
    );
  }

  const { did } = await params;
  const principalDid = decodeURIComponent(did);
  if (principalDid !== callerDid) {
    return NextResponse.json(
      { error: 'Only the principal may list its serving agents', onboarding: agentCardUrl() },
      { status: 403, headers: cors },
    );
  }

  try {
    const agents = await resolveServingAgents(principalDid);
    return NextResponse.json({ principal: principalDid, agents }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), principalDid }, '[identity/agents] resolve error');
    return NextResponse.json({ error: 'Failed to resolve serving agents' }, { status: 500, headers: cors });
  }
}
