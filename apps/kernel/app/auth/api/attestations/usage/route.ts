import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, identityMembers } from '@/src/db';
import { eq, and, isNull, lt } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@/src/lib/auth/middleware';
import { computeTurnUsageRollups, type RawTurnUsageRow } from './usage-rollup';

const USAGE_LIMIT_DEFAULT = 50;
const USAGE_LIMIT_MAX = 200;

interface UsageSelectRow {
  id: string;
  issuedAt: Date;
  payload: unknown;
}

/**
 * Identical body for "caller is not authorized" and "subject_did doesn't
 * exist" (#1967) — this route never branches on whether the subject row
 * exists, so the two cases are indistinguishable by construction, not just
 * by convention.
 */
const FORBIDDEN_BODY = { error: 'Forbidden' };

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Does `memberDid` hold an active (not-removed) `identity_members` row on
 * `subjectDid`, regardless of role (#1967)?
 *
 * Deliberately broader than the two other identity_members checks already in
 * this codebase: `isActiveGroupMember` (group-membership.ts) only authorizes
 * business/community/family-scope owners, and `hasActiveMembership`
 * (agent-authority.ts) only matches role='agent'. Neither covers this route's
 * requirement — a human *owner* of a personal agent identity (the
 * `identityDid: agentDid, memberDid: ownerDid, role: 'owner'` row
 * `mintAgentIdentity` writes) must also be able to read that agent's own
 * usage. Same table and shape as those two checks; no new auth primitive.
 */
async function isActiveIdentityMember(subjectDid: string, memberDid: string): Promise<boolean> {
  const [row] = await db
    .select({ memberDid: identityMembers.memberDid })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, subjectDid),
        eq(identityMembers.memberDid, memberDid),
        isNull(identityMembers.removedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Authorization for reading a subject's turn usage (#1967): the subject
 * itself, or an active `identity_members` member of the subject (any role —
 * see `isActiveIdentityMember`). A `usage:read` delegation-grant capability
 * would be the natural third path, but no such scope exists yet in the
 * closed grant registry (`packages/auth/src/grant-scopes.ts`) — adding one is
 * out of scope here, so subject-or-member is the full authorization surface
 * for this issue.
 */
async function canReadUsage(callerDid: string, subjectDid: string): Promise<boolean> {
  if (callerDid === subjectDid) return true;
  return isActiveIdentityMember(subjectDid, callerDid);
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
 * Per-turn spend is a behavioural fingerprint of the subject (#1967) — unlike
 * `GET /auth/api/attestations`'s legacy/mechanical-type anonymous-read
 * carve-out, this route requires a session (`requireAuth`, cookie-based —
 * matching its `/auth/api/attestations/*` siblings, e.g. `decline/route.ts`)
 * and gates the read to the subject itself or an active `identity_members`
 * member of the subject (`canReadUsage`). Every other caller — including one
 * passing a `subject_did` that doesn't exist — gets the identical 403
 * `FORBIDDEN_BODY`, so the response never leaks whether a DID exists.
 *
 * Deltas/rollups need the full session history up to (and including) each
 * returned row, so a page is computed from every non-revoked
 * `agent.turn.usage` row for the subject (optionally narrowed to one
 * session and to strictly-older-than-`before`) before the `limit` is
 * applied to the newest-first result.
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const { searchParams } = new URL(request.url);

  const subjectDid = searchParams.get('subject_did');
  if (!subjectDid) {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400, headers: cors });
  }

  const authorized = await canReadUsage(session.sub, subjectDid);
  if (!authorized) {
    return NextResponse.json(FORBIDDEN_BODY, { status: 403, headers: cors });
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
