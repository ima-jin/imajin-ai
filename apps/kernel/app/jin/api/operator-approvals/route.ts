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
 *
 * #2952: `?view=acting` explicitly selects the validated group's read-only
 * Inbox instead. Controller service restrictions are checked for `jin`;
 * delegated agents still have no Inbox. `canAccess` follows panel visibility
 * (node operator, group controller, or a principal with addressed cards).
 * This changes neither the default session projection nor decision authority.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { inboxDidFor } from '@/src/lib/notify/approval-addressing';
import { actAsContext } from '@/src/lib/notify/act-as-guard';
import { listApprovalsForOperator } from '@/src/lib/notify/operator-approvals-service';
import { isActiveGroupMember } from '@/src/lib/auth/group-membership';
import { reachActAsPrincipal } from '@/src/lib/notify/reach-approval-authority';
import { backfillReachApprovals } from '@/src/lib/notify/reach-approvals';
import { isReachApproval } from '@/src/lib/notify/reach-approval-contract';

export const dynamic = 'force-dynamic';

/**
 * The session Inbox plus, for a verified act-as owner/admin, the acting
 * principal's Reach/knock cards only (#2597). Backfill recovers failed or
 * pre-upgrade publications before listing.
 */
async function listInboxApprovals(inboxDid: string, reachPrincipal: string | null, source: string | null) {
  const filter = source ? { source } : {};
  const sharedPrincipal = reachPrincipal && reachPrincipal !== inboxDid ? reachPrincipal : null;
  await backfillReachApprovals(inboxDid);
  if (sharedPrincipal) await backfillReachApprovals(sharedPrincipal);
  const approvals = await listApprovalsForOperator(inboxDid, filter);
  if (sharedPrincipal) {
    const shared = await listApprovalsForOperator(sharedPrincipal, filter);
    approvals.push(...shared.filter(isReachApproval));
  }
  return approvals;
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  // Opt-in read projection for the shared nav and org Inbox. The legacy
  // session view and self-only decision rail retain their existing semantics.
  const { searchParams } = new URL(request.url);
  const actingView = searchParams.get('view') === 'acting';
  const authResult = await requireAuth(request, actingView ? { service: 'jin' } : undefined);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  if (actingView && identity.actingAs && (
    !['owner', 'admin'].includes(identity.actingAsRole ?? '') ||
    !await isActiveGroupMember(identity.actingAs, identity.id)
  )) {
    return NextResponse.json({ error: 'Organization Inbox requires an owner or admin of a group' }, { status: 403, headers: cors });
  }

  const sessionInboxDid = inboxDidFor(authResult.identity);
  const inboxDid = sessionInboxDid && actingView
    ? authResult.identity.actingAs ?? sessionInboxDid : sessionInboxDid;
  if (!inboxDid) {
    return NextResponse.json({ isOperator: false, approvals: [], ...(actingView ? { canAccess: false } : {}) }, { headers: cors });
  }

  const operatorDid = await getOperatorDid();
  const isOperator = operatorDid !== null && isOperatorIdentity(authResult.identity, operatorDid);

  const reachPrincipal = await reachActAsPrincipal(authResult.identity);
  const approvals = await listInboxApprovals(inboxDid, reachPrincipal, searchParams.get('source'));
  return NextResponse.json(
    {
      isOperator, approvals, actAs: actAsContext(authResult.identity), reachActAsAllowed: reachPrincipal !== null,
      ...(actingView ? { canAccess: isOperator || Boolean(authResult.identity.actingAs) || approvals.length > 0 } : {}),
    },
    { headers: cors },
  );
}

export function OPTIONS(request: NextRequest) {
  const response = corsOptions(request);
  const headers = response.headers.get('Access-Control-Allow-Headers');
  response.headers.set('Access-Control-Allow-Headers', [headers, 'X-Acting-As'].filter(Boolean).join(', '));
  return response;
}
