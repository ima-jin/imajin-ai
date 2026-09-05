/**
 * GET /usage/api/summary?did=&window= (#2030)
 *
 * Read model over the existing ledger — no new tables: `usage.incurred`
 * (our meter), `usage.billed` (the counterparty's statement), the drift
 * between them (`lib/usage/reconciliation.ts`), and the most recent
 * `usage.rollup` attestation signed inside the window.
 *
 * Auth: `requireAuth` + `resolveActingDid` — same "owner, or a registered
 * agent already delegated via `actingFor`" rule `usage/api/rollups/route.ts`
 * uses. `did` defaults to the caller's own effective DID; supplying a
 * different one is Forbidden.
 *
 * `window` (optional): `YYYY-MM` (a calendar month) or
 * `YYYY-MM-DD..YYYY-MM-DD` (an inclusive date range), both UTC. Defaults to
 * the current UTC month.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { readUsageSummary } from '@/src/lib/usage/summary';
import { parseUsageWindow } from '@/src/lib/usage/window';

const log = createLogger('kernel');

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
  const effectiveDid = resolveActingDid(authResult.identity);

  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did') ?? effectiveDid;

  if (did !== effectiveDid) {
    return NextResponse.json(
      { error: 'Forbidden - can only access your own usage summary' },
      { status: 403, headers: cors },
    );
  }

  const window = parseUsageWindow(searchParams.get('window'));
  if (!window) {
    return NextResponse.json(
      { error: 'window must be YYYY-MM or YYYY-MM-DD..YYYY-MM-DD' },
      { status: 400, headers: cors },
    );
  }

  try {
    const summary = await readUsageSummary({
      principalDid: did,
      from: window.from,
      to: window.to,
      windowLabel: window.label,
    });
    return NextResponse.json(summary, { headers: { ...cors, 'Cache-Control': 'no-store' } });
  } catch (err) {
    log.error({ err: String(err), did }, 'usage summary query failed');
    return NextResponse.json({ error: 'Usage summary unavailable' }, { status: 500, headers: cors });
  }
}
