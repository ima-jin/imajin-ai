/**
 * Ingestion route for static-secret connector (#1437).
 *
 * POST /inference/api/secret
 *   Principal seals a provider API key and issues a delegation grant to an
 *   app DID. Requires `inference:write` app-auth scope.
 *
 *   Body: { principalDid: string, granteeDid: string, secret: string, expiresAt?: string (ISO) }
 *   201: { ok: true, grantId: string }
 *
 * The grantee (app DID) can then call the inference engine; policy.ts resolves
 * the key from the vault via the active grant at inference time. Revoking the
 * grant (POST /inference/api/secret/revoke) makes the inference call fail closed.
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
  const secret = typeof body.secret === 'string' ? body.secret : null;

  if (!principalDid || !granteeDid || !secret) {
    return NextResponse.json(
      { error: 'principalDid, granteeDid and secret (string) are required' },
      { status: 400, headers: cors },
    );
  }

  const rawExpiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : null;
  const expiresAt = rawExpiresAt !== null ? new Date(rawExpiresAt) : undefined;

  if (expiresAt !== undefined && Number.isNaN(expiresAt.getTime())) {
    return NextResponse.json({ error: 'expiresAt must be a valid ISO date string' }, { status: 400, headers: cors });
  }

  try {
    const { grantId } = await inferenceModelKeyConnector.sealAndGrant(
      principalDid,
      granteeDid,
      secret,
      expiresAt !== undefined ? { expiresAt } : {},
    );
    return NextResponse.json({ ok: true, grantId }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid, granteeDid }, 'inference secret seal+grant failed');
    return NextResponse.json({ error: 'Failed to seal and grant secret' }, { status: 500, headers: cors });
  }
}
