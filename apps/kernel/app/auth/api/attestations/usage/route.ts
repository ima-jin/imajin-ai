import { NextRequest, NextResponse } from 'next/server';
import { db, attestations } from '@/src/db';
import { eq, and, isNull, lt } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { computeTurnUsageRollups, type RawTurnUsageRow } from './usage-rollup';

const USAGE_LIMIT_DEFAULT = 50;
const USAGE_LIMIT_MAX = 200;

interface UsageSelectRow {
  id: string;
  issuedAt: Date;
  payload: unknown;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /auth/api/attestations/usage?subject_did=...&session=...&limit=...&before=...
 *
 * Purpose-built read for the `agent.turn.usage` telemetry seam (#1863):
 * returns that subject's turns, newest first, annotated with server-computed
 * per-turn token deltas and running session rollups — so every consumer
 * (dashboard, CLI, future agents) stays dumb and consistent instead of each
 * re-deriving the same math client-side from the raw
 * `GET /auth/api/attestations` history.
 *
 * `agent.turn.usage` is a hardcoded (non-registry) attestation type, so —
 * mirroring `GET /auth/api/attestations`'s behavior for legacy/mechanical
 * types — this endpoint is anonymous-callable; disclosure-scope gating only
 * applies to types registered via `/auth/api/attestations/types`.
 *
 * Deltas/rollups need the full session history up to (and including) each
 * returned row, so a page is computed from every non-revoked
 * `agent.turn.usage` row for the subject (optionally narrowed to one
 * session and to strictly-older-than-`before`) before the `limit` is
 * applied to the newest-first result.
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  const { searchParams } = new URL(request.url);

  const subjectDid = searchParams.get('subject_did');
  if (!subjectDid) {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400, headers: cors });
  }

  const sessionFilter = searchParams.get('session');

  const limitParam = Number.parseInt(searchParams.get('limit') ?? String(USAGE_LIMIT_DEFAULT), 10);
  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? USAGE_LIMIT_DEFAULT : limitParam), USAGE_LIMIT_MAX);

  const beforeParam = searchParams.get('before');
  let beforeDate: Date | undefined;
  if (beforeParam) {
    const parsed = new Date(beforeParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'before must be a valid ISO 8601 timestamp' }, { status: 400, headers: cors });
    }
    beforeDate = parsed;
  }

  const conditions = [
    eq(attestations.type, 'agent.turn.usage'),
    eq(attestations.subjectDid, subjectDid),
    isNull(attestations.revokedAt),
  ];
  if (beforeDate) {
    // Rollups for a row only ever depend on history at-or-before that row's
    // own issuedAt, so it is safe to exclude rows at/after the cursor
    // up front rather than computing over the full unbounded history.
    conditions.push(lt(attestations.issuedAt, beforeDate));
  }

  try {
    const rows = await db
      .select({ id: attestations.id, issuedAt: attestations.issuedAt, payload: attestations.payload })
      .from(attestations)
      .where(and(...conditions))
      .orderBy(attestations.issuedAt);

    const rawRows: RawTurnUsageRow[] = (sessionFilter
      ? (rows as UsageSelectRow[]).filter(
          (row: UsageSelectRow) => (row.payload as { session?: unknown } | null)?.session === sessionFilter,
        )
      : (rows as UsageSelectRow[])
    ).map((row: UsageSelectRow) => ({ id: row.id, issuedAt: new Date(row.issuedAt), payload: row.payload }));

    const computedAscending = computeTurnUsageRollups(rawRows);
    const newestFirst = computedAscending.slice().reverse();
    const page = newestFirst.slice(0, limit);

    return NextResponse.json(page, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Attestations usage GET error');
    return NextResponse.json({ error: 'Failed to query turn usage' }, { status: 500, headers: cors });
  }
});
