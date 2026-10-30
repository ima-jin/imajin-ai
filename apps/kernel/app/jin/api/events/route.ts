/**
 * GET /jin/api/events — Record lane read API (#2289, child of the /jin
 * epic #2288).
 *
 * Per-principal counterpart to `GET /api/admin/events` (requireAdmin
 * only): service-scoped `requireAuth` + session act-as, never
 * `requireAdmin`. See `src/lib/jin/record-events.ts` for the full scoping
 * rules, the `approvalRef` join, and `hasOperatorSignature`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { listRecordEventsForPrincipal, type RecordEventFilters } from '@/src/lib/jin/record-events';
import { isActiveGroupMember } from '@/src/lib/auth/group-membership';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

/** Non-empty trimmed value for a query param, or undefined when absent. */
function param(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim() ?? '';
  return value.length === 0 ? undefined : value;
}

function readFilters(url: URL): RecordEventFilters {
  const query = url.searchParams;
  const kind = query.get('kind');
  const limit = Number.parseInt(param(query, 'limit') ?? '', 10);
  const offset = Number.parseInt(param(query, 'offset') ?? '', 10);

  return {
    ...(kind === 'person' || kind === 'agent' ? { kind } : {}),
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

  const authResult = await requireAuth(request, { service: 'jin' });
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { identity } = authResult;
  const principalDid = identity.actingAs ?? identity.id;
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  if (kind !== null && kind !== 'person' && kind !== 'agent') {
    return NextResponse.json({ error: 'kind must be person or agent' }, { status: 400, headers: cors });
  }
  const filters = readFilters(url);

  try {
    if (identity.actingAs && (
      identity.subtype !== 'human' || identity.actingFor ||
      !['owner', 'admin'].includes(identity.actingAsRole ?? '') ||
      !await isActiveGroupMember(identity.actingAs, identity.id)
    )) {
      return NextResponse.json({ error: 'Organization Record requires an owner or admin of a group' }, { status: 403, headers: cors });
    }
    // Record access is jin-scoped, but a grant reference must not bypass the
    // existing auth-service read boundary on /auth/api/grants.
    const grantAuth = identity.actingAs ? await requireAuth(request, { service: 'auth' }) : authResult;
    const canReadGrants = !('error' in grantAuth) && !identity.actingFor && identity.subtype !== 'agent';
    const scope = {
      ...(identity.actingAs ? { organization: true } : {}),
      ...(!canReadGrants ? { canReadGrants: false } : {}),
      ...(identity.actingFor ? { canReadApprovals: false } : {}),
    };
    const page = Object.keys(scope).length
      ? await listRecordEventsForPrincipal(principalDid, filters, scope)
      : await listRecordEventsForPrincipal(principalDid, filters);
    return NextResponse.json(page, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid }, 'Record lane events query failed');
    return NextResponse.json({ error: 'Failed to list events' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
