/**
 * POST /auth/api/access/bearers/:id/revoke — REVOKE step (#2252). Tombstone:
 * the `delegate_grant_bearers` row survives (audit trail) but its
 * `tokenHash` is erased, so the plaintext bearer can never resolve again —
 * see `src/lib/access/delegate-grant.ts`'s docs on why that also collapses
 * a revoked bearer into the same 'unknown' denial as a token that never
 * existed. No approval-card round trip: revocation is deliberately
 * immediate and always available to the owning principal — gating it
 * behind another operator decision would only slow down the one action
 * that most needs to be fast when a credential leaks.
 *
 * Only the bearer's own `principalDid` may revoke it — a 404 either way
 * (not found vs. forbidden) so a caller can't enumerate other principals'
 * bearer ids.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { revokeDelegateGrantBearer } from '@/src/lib/access/delegate-grant';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const { id } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const outcome = await revokeDelegateGrantBearer({ bearerId: id, requestedByDid: authResult.identity.id });

  switch (outcome) {
    case 'revoked':
    case 'already_revoked':
      return NextResponse.json({ ok: true, status: outcome }, { headers: cors });
    case 'not_found':
    case 'forbidden':
      // Same 404 either way — never disclose whether a bearer id owned by
      // someone else exists.
      return NextResponse.json({ error: 'Bearer not found' }, { status: 404, headers: cors });
    default:
      return NextResponse.json({ error: 'Failed to revoke bearer' }, { status: 500, headers: cors });
  }
}
