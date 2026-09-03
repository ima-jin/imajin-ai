import { NextRequest, NextResponse } from 'next/server';
import { getProvision, revokeProvision } from '@/src/lib/auth/agent-provisioner';
import { resolveCallerIdentity, isCallerIdentityError } from '@/src/lib/auth/require-caller-did';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /auth/api/agents/provision/[id]
 *
 * Provision detail (#1933 deliverable 3): full record including the
 * envelope manifest (file names + manual steps, never file contents with
 * secrets — see `[id]/bundle` for the full local-placement bundle).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveCallerIdentity(request);
  if (isCallerIdentityError(auth)) {
    return auth.errorResponse;
  }
  const { callerDid } = auth;
  const { id } = await params;

  try {
    const provision = await getProvision(id);
    if (!provision) {
      return NextResponse.json({ error: 'Provision not found' }, { status: 404 });
    }
    if (provision.servingDid !== callerDid && provision.agentDid !== callerDid) {
      return NextResponse.json({ error: 'Not authorized to view this provision' }, { status: 403 });
    }
    return NextResponse.json({ provision });
  } catch (error) {
    log.error({ err: String(error) }, '[agents/provision/id] Get error');
    return NextResponse.json({ error: 'Failed to fetch provision' }, { status: 500 });
  }
}

/**
 * DELETE /auth/api/agents/provision/[id]
 *
 * Revoke a provision — revocation is first-class (#1933 deliverable 3):
 * revokes the issued grant (if any) and marks the record 'revoked'. Never a
 * silent delete; the row and its step history remain visible.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveCallerIdentity(request);
  if (isCallerIdentityError(auth)) {
    return auth.errorResponse;
  }
  const { callerDid } = auth;
  const { id } = await params;

  try {
    const result = await revokeProvision(id, callerDid);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (error) {
    log.error({ err: String(error) }, '[agents/provision/id] Revoke error');
    return NextResponse.json({ error: 'Failed to revoke provision' }, { status: 500 });
  }
}
