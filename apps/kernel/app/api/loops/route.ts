/**
 * `/api/loops` — kernel loop registry (#2295, epic #2288/#2290).
 *
 * `POST` is the signed ingest endpoint: any publisher (Warp's own dispatch
 * loop, the OpenClaw plugin translating gateway-side lifecycle hooks, a
 * review sub-agent) submits a `loop.started|progress|blocked|finished`
 * envelope signed with its own DID key. The kernel verifies that signature
 * against the publisher DID's currently registered key (see
 * `src/lib/loops/verify-publisher-signature.ts` — same pattern as the
 * operator-approvals countersignature) before publishing it onto the bus;
 * an unsigned or forged event is rejected with 400 and never persisted.
 * A validly signed event is then checked for publisher *authorization*
 * (#2358, `src/lib/loops/authorize-publisher.ts`) — does this publisher DID
 * actually have standing to write history for `payload.principal`? Self-
 * attestation, the kernel's own node-witness DID (#2338), or an active
 * `loops:publish` delegation grant (#1882) from that principal all pass;
 * anything else is rejected with 403 before publishing.
 *
 * `GET` is the per-principal read: `requireAuth` + `resolveActingDid` (the
 * same delegation precedence every other authenticated route uses) resolve
 * the caller's effective DID, and every row returned is scoped to
 * `principal = effectiveDid` — an operator sees their own loops, and an
 * agent authenticated with `X-Acting-For` sees the principal it acts for
 * (#2290 acceptance: "non-operator sees nothing" — there is no cross-DID
 * read path here to gate, the query itself only ever selects the caller's
 * own rows).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { parseLoopIngestRequest } from '@/src/lib/loops/types';
import { ingestLoopEvent } from '@/src/lib/loops/ingest';
import { listLoops } from '@/src/lib/loops/query';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const parsed = parseLoopIngestRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
  }

  const result = await ingestLoopEvent(parsed.value);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}) },
      { status: result.status, headers: cors },
    );
  }

  return NextResponse.json(
    { ok: true, loopId: parsed.value.payload.loopId },
    { status: 201, headers: cors },
  );
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const effectiveDid = resolveActingDid(auth.identity);

  const { searchParams } = new URL(request.url);
  const principalParam = searchParams.get('principal');
  if (principalParam && principalParam !== effectiveDid) {
    // Never a broader lookup than the caller's own delegation resolves to —
    // ?principal= can only ever confirm the caller's own effective DID.
    return NextResponse.json(
      { error: 'principal must match the authenticated caller' },
      { status: 403, headers: cors },
    );
  }

  const limitParam = searchParams.get('limit');
  const loops = await listLoops({
    principal: effectiveDid,
    state: searchParams.get('state'),
    kind: searchParams.get('kind'),
    since: searchParams.get('since'),
    ancestor: searchParams.get('ancestor'),
    limit: limitParam ? Number.parseInt(limitParam, 10) : undefined,
  });

  return NextResponse.json({ loops }, { headers: cors });
}
