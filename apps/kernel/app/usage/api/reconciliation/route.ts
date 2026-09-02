/**
 * GET /usage/api/reconciliation (#1076 Stage 1)
 *
 * Computed (`usage.incurred`, OUR meter) vs billed (`usage.billed`, the
 * COUNTERPARTY'S STATEMENT) per provider/day/model, plus the drift between
 * them — see `@/src/lib/usage/reconciliation` for the query itself. Owner-only:
 * the caller only ever reads their own principal's rows, resolved the same
 * way `/connections/api/connectors/[id]/spend` does for the existing
 * `infer:usage-read` scope (this route reads the same class of financial
 * fact — a burn-down vs. reconciliation view over the same principal's
 * inference spend — so it reuses that scope rather than adding a new one).
 *
 * Query params (all optional):
 *   provider — restrict to one provider id (e.g. `anthropic`).
 *   from     — inclusive lower bound, RFC 3339 date/time.
 *   to       — exclusive upper bound, RFC 3339 date/time.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { resolveEffectiveDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { readReconciliation } from '@/src/lib/usage/reconciliation';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function responseHeaders(request: NextRequest): Record<string, string> {
  return { ...corsHeaders(request), 'Cache-Control': 'no-store' };
}

/** Parse an RFC 3339 query param into a `Date`, or `undefined` for absent/invalid input. */
function parseDateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function GET(request: NextRequest) {
  const headers = responseHeaders(request);

  const auth = await resolveEffectiveDid(request, { scope: 'infer:usage-read' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }
  const { effectiveDid: principalDid } = auth;

  const params = request.nextUrl.searchParams;
  const provider = params.get('provider') ?? undefined;
  const from = parseDateParam(params.get('from'));
  const to = parseDateParam(params.get('to'));

  try {
    const rows = await readReconciliation({ principalDid, provider, from, to });
    return NextResponse.json({ rows }, { headers });
  } catch (err) {
    log.error({ err: String(err), principalDid, provider }, 'Usage reconciliation query failed');
    return NextResponse.json({ error: 'Usage reconciliation unavailable' }, { status: 500, headers });
  }
}
