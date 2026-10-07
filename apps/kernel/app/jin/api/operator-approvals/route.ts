/**
 * GET /jin/api/operator-approvals — list operator approval proposals (#2059,
 * open source/kind vocabulary #2152).
 *
 * Powers the /jin operator-approvals confirm-card panel — the Inbox.
 *
 * #2723: the Inbox is scoped to the SESSION DID. Every principal reads the
 * rows addressed to them: the node operator gets node-level kinds (gateway,
 * config, apps:provision, vault, …) plus their own connector proposals; any
 * other principal gets the connector proposals their own agent raised, and
 * nothing of anyone else's. The node operator does NOT see another
 * principal's connector proposals — not even read-only. A delegated agent
 * (`X-Acting-For`) has no Inbox: `{ isOperator: false, approvals: [] }`,
 * indistinguishable from "nothing pending". `isOperator` still reports
 * whether the session is the node operator (the panel and other operator-
 * only lanes key off it); it no longer gates this list.
 *
 * Optional `?source=` query param scopes the list to one source (#2152) —
 * a view filter only, never a security boundary, since every returned row
 * is already addressed to this session.
 *
 * #2359: this READ surface keeps working under act-as — the queue is the
 * session's own either way, and hiding it would just make the act-as
 * state harder to notice, which is the failure mode #2359 is about. What
 * it adds is `actAs`: non-null whenever the acting DID differs from the
 * real session DID, so the panel can render its approve/deny controls
 * disabled with an explanation instead of offering a tap the confirm rail
 * will refuse with 403 `act_as_not_permitted`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { inboxDidFor } from '@/src/lib/notify/approval-addressing';
import { actAsContext } from '@/src/lib/notify/act-as-guard';
import { listApprovalsForOperator } from '@/src/lib/notify/operator-approvals-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const inboxDid = inboxDidFor(authResult.identity);
  if (!inboxDid) {
    return NextResponse.json({ isOperator: false, approvals: [] }, { headers: cors });
  }

  const operatorDid = await getOperatorDid();
  const isOperator = operatorDid !== null && isOperatorIdentity(authResult.identity, operatorDid);

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source');
  const approvals = await listApprovalsForOperator(inboxDid, source ? { source } : {});
  return NextResponse.json(
    { isOperator, approvals, actAs: actAsContext(authResult.identity) },
    { headers: cors },
  );
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
