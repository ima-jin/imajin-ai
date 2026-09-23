/**
 * GET /jin/api/events — Record lane read API (#2289, child of the /jin
 * epic #2288).
 *
 * Per-principal counterpart to `GET /api/admin/events` (requireAdmin
 * only): `requireAuth` + `X-Acting-For` (`resolveActingDid`), never
 * `requireAdmin`. See `src/lib/jin/record-events.ts` for the full scoping
 * rules, the `approvalRef` join, and `hasOperatorSignature`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { listRecordEventsForPrincipal, type RecordEventFilters } from '@/src/lib/jin/record-events';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/** Non-empty trimmed value for a query param, or undefined when absent. */
function param(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim() ?? '';
  return value.length === 0 ? undefined : value;
}

function readFilters(url: URL): RecordEventFilters {
  const query = url.searchParams;
  const limit = Number.parseInt(param(query, 'limit') ?? '', 10);
  const offset = Number.parseInt(param(query, 'offset') ?? '', 10);

  return {
    ...(param(query, 'action') === undefined ? {} : { action: param(query, 'action') }),
    ...(param(query, 'since') === undefined ? {} : { since: param(query, 'since') }),
    ...(param(query, 'agent') === undefined ? {} : { agent: param(query, 'agent') }),
    ...(param(query, 'grant') === undefined ? {} : { grant: param(query, 'grant') }),
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(offset) ? { offset } : {}),
  };
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const principalDid = resolveActingDid(authResult.identity);
  const filters = readFilters(new URL(request.url));

  try {
    const page = await listRecordEventsForPrincipal(principalDid, filters);
    return NextResponse.json(page, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid }, 'Record lane events query failed');
    return NextResponse.json({ error: 'Failed to list events' }, { status: 500, headers: cors });
  }
}
