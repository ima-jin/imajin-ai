/**
 * GET /jin/api/grants — list every standing-authority grant this operator
 * holds, normalized across sources (#2292). Powers the /jin Grants lane
 * panel.
 *
 * Same operator-identity gate as `GET /jin/api/operator-approvals` (#2059):
 * a non-operator identity — including `@jin` itself, or anyone else
 * authenticated on this node — gets `{ isOperator: false, grants: [] }`,
 * indistinguishable from "no grants" so this endpoint never confirms
 * whether a grant exists to a caller who isn't allowed to see it.
 *
 * Zero new backend: `listGrantsForOperator` reads through EXISTING list
 * surfaces only (see `src/lib/jin/grants-lane.ts`'s module docs for the
 * full source→route mapping). This route never mutates anything —
 * one-tap revoke posts directly to each source's own existing
 * revoke/DELETE route from the panel.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { listGrantsForOperator } from '@/src/lib/jin/grants-lane';

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
    return NextResponse.json({ isOperator: false, grants: [] }, { headers: cors });
  }

  const grants = await listGrantsForOperator(operatorDid);
  return NextResponse.json({ isOperator: true, grants }, { headers: cors });
}
