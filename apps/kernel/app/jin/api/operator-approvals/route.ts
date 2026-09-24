/**
 * GET /jin/api/operator-approvals — list operator approval proposals (#2059,
 * open source/kind vocabulary #2152).
 *
 * Powers the /jin operator-approvals confirm-card panel. A non-operator
 * identity — including `@jin` itself, or anyone else authenticated on this
 * node — gets `{ isOperator: false, approvals: [] }`: no card, no data,
 * indistinguishable from "nothing pending" so this endpoint never confirms
 * whether a proposal exists to a caller who isn't allowed to see it.
 *
 * Optional `?source=` query param scopes the list to one source (#2152) —
 * a view filter only, never a security boundary, since every returned row
 * already belongs to this operator.
 *
 * #2359: this READ surface keeps working under act-as — the queue is the
 * operator's own either way, and hiding it would just make the act-as
 * state harder to notice, which is the failure mode #2359 is about. What
 * it adds is `actAs`: non-null whenever the acting DID differs from the
 * real session DID, so the panel can render its approve/deny controls
 * disabled with an explanation instead of offering a tap the confirm rail
 * will refuse with 403 `act_as_not_permitted`. Only ever present on the
 * operator branch — the non-operator response stays byte-identical.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { actAsContext } from '@/src/lib/notify/act-as-guard';
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

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source');
  const approvals = await listApprovalsForOperator(operatorDid, source ? { source } : {});
  return NextResponse.json(
    { isOperator: true, approvals, actAs: actAsContext(authResult.identity) },
    { headers: cors },
  );
}
