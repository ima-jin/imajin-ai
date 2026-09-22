/**
 * GET /auth/api/access/bearers — list the CALLER's own delegate-grant
 * bearers (#2252). Metadata only: label, scopes, surfaces, issuedAt,
 * lastUsedAt, expiresAt, hardCapAt, status — never the bearer plaintext or
 * its hash, which cannot be reconstructed once the approve response has
 * been consumed (see `src/lib/access/delegate-grant.ts`'s module docs).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { listDelegateGrantBearersForPrincipal } from '@/src/lib/access/delegate-grant';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const bearers = await listDelegateGrantBearersForPrincipal(authResult.identity.id);
  return NextResponse.json({ bearers }, { headers: cors });
}
