/**
 * GET /warp/api/runs (#1639)
 *
 * List the Warp cloud-agent runs the caller's own sealed Agent key can see. The
 * key *is* the scope: a DID lists only what its own credential created, so run
 * history is per-jin by construction rather than by a filter we have to trust.
 *
 * Query params (camelCase, matching the dispatch route's body):
 *   ?name=veteze-jin            — Warp `config.name`, i.e. the {username}-jin tag
 *   ?state=QUEUED&state=INPROGRESS — repeatable; matches any of the given states
 *   ?environmentId=…            — runs that landed in one cloud environment
 *   ?createdAfter=2026-08-01T00:00:00Z — RFC-3339 lower bound
 *   ?limit=50                   — 1–500, clamped rather than rejected
 *   ?cursor=…                   — `nextCursor` from a previous page
 *
 * Returns `{ runs, hasNextPage, nextCursor }`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { listAgentRuns, type ListAgentRunsInput } from '@/src/lib/warp/dispatch';
import { warpActingDid } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

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

/**
 * Read the filters off the query string.
 *
 * An unparseable `limit` is dropped rather than 400'd — the caller still gets
 * their runs at Warp's default page size, which is a better answer to a typo in
 * an optional pagination hint than no answer at all.
 */
function readFilters(url: URL): ListAgentRunsInput {
  const query = url.searchParams;
  const states = query.getAll('state').map((s) => s.trim()).filter((s) => s.length > 0);
  const limit = Number(param(query, 'limit'));

  return {
    ...(param(query, 'name') === undefined ? {} : { name: param(query, 'name') }),
    ...(states.length === 0 ? {} : { states }),
    ...(param(query, 'environmentId') === undefined
      ? {}
      : { environmentId: param(query, 'environmentId') }),
    ...(param(query, 'createdAfter') === undefined
      ? {}
      : { createdAfter: param(query, 'createdAfter') }),
    ...(param(query, 'cursor') === undefined ? {} : { cursor: param(query, 'cursor') }),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  };
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const filters = readFilters(new URL(request.url));

  try {
    const page = await listAgentRuns(acting.did, filters);
    return NextResponse.json(page, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid: acting.did }, 'Warp run list failed');
    return warpErrorResponse(err, cors);
  }
}
