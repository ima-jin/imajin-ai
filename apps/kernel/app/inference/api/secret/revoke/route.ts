/**
 * Revocation route for static-secret connector (#1437).
 *
 * POST /inference/api/secret/revoke
 *   Deactivates the active delegation grant for a (principalDid, granteeDid)
 *   pair. After revocation, any inference call for the grantee's vocabulary
 *   fails closed — the vault unseal finds no active grant and throws.
 *   Requires `inference:write` app-auth scope.
 *
 *   Body: { principalDid: string, granteeDid: string }
 *   200: { ok: true }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { inferenceModelKeyConnector } from '@/src/lib/kernel/connector-static-secret';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(request);

  const appResult = await requireAppAuth(request, { scope: 'inference:write' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const principalDid = typeof body.principalDid === 'string' ? body.principalDid : null;
  const granteeDid = typeof body.granteeDid === 'string' ? body.granteeDid : null;

  if (!principalDid || !granteeDid) {
    return NextResponse.json(
      { error: 'principalDid and granteeDid are required' },
      { status: 400, headers: cors },
    );
  }

  try {
    await inferenceModelKeyConnector.revokeGrant(granteeDid, principalDid);
    return NextResponse.json({ ok: true }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid, granteeDid }, 'inference secret grant revocation failed');
    return NextResponse.json({ error: 'Failed to revoke grant' }, { status: 500, headers: cors });
  }
}
