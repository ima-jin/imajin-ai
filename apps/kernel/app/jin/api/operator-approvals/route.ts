/**
 * GET /jin/api/operator-approvals — list operator approval proposals (#2059).
 *
 * Powers the /jin operator-approvals confirm-card panel. A non-operator
 * identity — including `@jin` itself, or anyone else authenticated on this
 * node — gets `{ isOperator: false, approvals: [] }`: no card, no data,
 * indistinguishable from "nothing pending" so this endpoint never confirms
 * whether a proposal exists to a caller who isn't allowed to see it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { listApprovalsForOperator } from '@/src/lib/notify/operator-approvals-service';

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

  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    return NextResponse.json({ isOperator: false, approvals: [] }, { headers: cors });
  }

  const approvals = await listApprovalsForOperator(operatorDid);
  return NextResponse.json({ isOperator: true, approvals }, { headers: cors });
}
