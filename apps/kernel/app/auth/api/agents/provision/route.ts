import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse, agentCardUrl } from '@imajin/auth';
import { createProvision, listProvisions, ProvisionError, type ProvisionHarness, type ProvisionPlacement } from '@/src/lib/auth/agent-provisioner';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * POST /auth/api/agents/provision
 *
 * Envelope provisioner (#1933): owner picks a serving DID, describes an
 * agent (name, harness, scopes, model/route, placement), and the kernel
 * mints identity + minimal grants + assembles the RFC-31 envelope.
 *
 * Auth mirrors `POST /auth/api/grants` (#1882): the caller must act
 * directly (no `X-Acting-For` delegation — a provision, like a grant, is
 * only ever created by the owning principal itself) and `servingDid` must
 * equal the caller's own effective DID.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const { identity } = authResult;

  if (identity.actingFor) {
    return NextResponse.json(
      { error: 'Provisions must be created by the owning principal directly, not while acting under agent delegation', onboarding: agentCardUrl() },
      { status: 403 },
    );
  }
  const callerDid = identity.actingAs ?? identity.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { servingDid, name, harness, placement, scopes, model, idempotencyKey } = body as {
    servingDid?: string;
    name?: string;
    harness?: string;
    placement?: string;
    scopes?: string[];
    model?: { provider?: string; via?: 'kernel-passthrough' | 'direct' };
    idempotencyKey?: string;
  };

  if (!servingDid || typeof servingDid !== 'string') {
    return NextResponse.json({ error: 'servingDid is required' }, { status: 400 });
  }
  if (servingDid !== callerDid) {
    return NextResponse.json({ error: 'Only the owning DID may provision an agent for itself', onboarding: agentCardUrl() }, { status: 403 });
  }
  if (!Array.isArray(scopes)) {
    return NextResponse.json({ error: 'scopes must be an array of strings' }, { status: 400 });
  }

  try {
    const provision = await createProvision({
      servingDid,
      name: name ?? '',
      harness: harness as ProvisionHarness,
      placement: placement as ProvisionPlacement,
      scopes,
      model,
      idempotencyKey,
    });
    return NextResponse.json({ provision }, { status: 201 });
  } catch (error) {
    if (error instanceof ProvisionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    log.error({ err: String(error) }, '[agents/provision] Create error');
    return NextResponse.json({ error: 'Failed to create provision' }, { status: 500 });
  }
}

/**
 * GET /auth/api/agents/provision
 *
 * List the caller's own provisions (Agent View pane, #1933 deliverable 3).
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const { identity } = authResult;
  const servingDid = identity.actingAs ?? identity.id;

  try {
    const provisions = await listProvisions(servingDid);
    return NextResponse.json({ provisions });
  } catch (error) {
    log.error({ err: String(error) }, '[agents/provision] List error');
    return NextResponse.json({ error: 'Failed to list provisions' }, { status: 500 });
  }
}
