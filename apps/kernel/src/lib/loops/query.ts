/**
 * Kernel loop registry reads (#2295, epic #2288/#2290).
 *
 * Raw SQL via `@imajin/db`'s `getClient()` — a recursive CTE (the ancestor
 * lineage walk) has no ergonomic Drizzle query-builder equivalent, so both
 * `GET /api/loops` and `GET /api/loops/:loopId` read this way, same
 * approach as `apps/kernel/app/profile/lib/network-check.ts`'s recursive
 * connection-network BFS and `apps/kernel/app/api/admin/events/route.ts`'s
 * filtered query.
 *
 * Every query here is unconditionally scoped to `principal` — the caller's
 * per-principal authz boundary (#2290 acceptance: "non-operator sees
 * nothing"). Optional filters are passed through as nullable parameters
 * rather than composed as conditional SQL fragments, so every call site
 * emits exactly one fixed query shape regardless of which filters are set
 * (simpler to reason about and to test).
 */
import { getClient } from '@imajin/db';
import { serializeLoop, serializeLoopEvent, type LoopJson, type LoopEventJson, type RawLoopRow, type RawLoopEventRow } from './serialize';

export interface ListLoopsFilters {
  principal: string;
  state?: string | null;
  kind?: string | null;
  since?: string | null;
  ancestor?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(limit));
}

/** `GET /api/loops?ancestor=` — full descendant lineage tree rooted at `ancestor`, scoped to `principal`. */
async function listLoopLineage(
  ancestor: string,
  principal: string,
  state: string | null,
  kind: string | null,
): Promise<LoopJson[]> {
  const sql = getClient();
  const rows = (await sql`
    WITH RECURSIVE lineage AS (
      SELECT * FROM kernel.loops WHERE loop_id = ${ancestor} AND principal = ${principal}
      UNION ALL
      SELECT l.* FROM kernel.loops l
      JOIN lineage ON l.parent_loop_id = lineage.loop_id
      WHERE l.principal = ${principal}
    )
    SELECT * FROM lineage
    WHERE (${state}::text IS NULL OR state = ${state})
      AND (${kind}::text IS NULL OR kind = ${kind})
    ORDER BY started_at ASC
  `) as unknown as RawLoopRow[];

  return rows.map(serializeLoop);
}

/** `GET /api/loops` — the caller's own loops, newest-active first. */
async function listLoopsForPrincipal(filters: ListLoopsFilters): Promise<LoopJson[]> {
  const sql = getClient();
  const limit = clampLimit(filters.limit);
  const rows = (await sql`
    SELECT * FROM kernel.loops
    WHERE principal = ${filters.principal}
      AND (${filters.state ?? null}::text IS NULL OR state = ${filters.state ?? null})
      AND (${filters.kind ?? null}::text IS NULL OR kind = ${filters.kind ?? null})
      AND (${filters.since ?? null}::timestamptz IS NULL OR last_seen_at >= ${filters.since ?? null}::timestamptz)
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `) as unknown as RawLoopRow[];

  return rows.map(serializeLoop);
}

export async function listLoops(filters: ListLoopsFilters): Promise<LoopJson[]> {
  if (filters.ancestor) {
    return listLoopLineage(filters.ancestor, filters.principal, filters.state ?? null, filters.kind ?? null);
  }
  return listLoopsForPrincipal(filters);
}

// ── Cursor-paginated listing (MCP `loops_list`, #2297) ──────────────────────
//
// `listLoops` above serves `GET /api/loops` and takes a flat `limit` with no
// cursor — that contract is unchanged. `loops_list` additionally needs a
// stable "next page" token so an orchestrating agent can page through a large
// backlog without re-reading rows it already saw. Rather than bolt cursor
// semantics onto the existing function (and risk shifting `GET /api/loops`
// ordering/behavior), this is an additive, MCP-only entry point that reuses
// the same table, WHERE-clause conventions, and `serializeLoop` mapping.

export interface ListLoopsPageFilters extends ListLoopsFilters {
  /** Opaque token from a previous page's `nextCursor`. Ignored when `ancestor` is set. */
  cursor?: string | null;
}

export interface LoopsPage {
  loops: LoopJson[];
  hasNextPage: boolean;
  nextCursor: string | null;
}

interface LoopCursorState {
  lastSeenAt: string;
  loopId: string;
}

/** Encode the last row of a page as an opaque `(lastSeenAt, loopId)` cursor. */
function encodeLoopCursor(loop: Pick<LoopJson, 'lastSeenAt' | 'loopId'>): string {
  return Buffer.from(JSON.stringify({ lastSeenAt: loop.lastSeenAt, loopId: loop.loopId })).toString('base64url');
}

/** Decode a cursor token, or `null` for a missing/malformed one (never throws — a bad cursor just restarts the list). */
function decodeLoopCursor(cursor: string | null | undefined): LoopCursorState | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<LoopCursorState>;
    if (typeof parsed.lastSeenAt === 'string' && typeof parsed.loopId === 'string') {
      return { lastSeenAt: parsed.lastSeenAt, loopId: parsed.loopId };
    }
  } catch {
    // fall through to null — malformed cursor is treated as "start over"
  }
  return null;
}

/**
 * `loops_list` (non-ancestor path) — the caller's own loops, newest-active
 * first, one page at a time. Orders by `(last_seen_at, loop_id)` DESC so the
 * cursor tie-breaks deterministically even when two loops share a
 * `last_seen_at` timestamp. Fetches one extra row over `limit` to detect
 * `hasNextPage` without a separate COUNT query.
 */
async function listLoopsForPrincipalPage(filters: ListLoopsPageFilters): Promise<LoopsPage> {
  const sql = getClient();
  const limit = clampLimit(filters.limit);
  const cursor = decodeLoopCursor(filters.cursor);
  const cursorLastSeenAt = cursor?.lastSeenAt ?? null;
  const cursorLoopId = cursor?.loopId ?? null;

  const rows = (await sql`
    SELECT * FROM kernel.loops
    WHERE principal = ${filters.principal}
      AND (${filters.state ?? null}::text IS NULL OR state = ${filters.state ?? null})
      AND (${filters.kind ?? null}::text IS NULL OR kind = ${filters.kind ?? null})
      AND (${filters.since ?? null}::timestamptz IS NULL OR last_seen_at >= ${filters.since ?? null}::timestamptz)
      AND (
        ${cursorLastSeenAt}::timestamptz IS NULL
        OR last_seen_at < ${cursorLastSeenAt}::timestamptz
        OR (last_seen_at = ${cursorLastSeenAt}::timestamptz AND loop_id < ${cursorLoopId})
      )
    ORDER BY last_seen_at DESC, loop_id DESC
    LIMIT ${limit + 1}
  `) as unknown as RawLoopRow[];

  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;
  const loops = page.map(serializeLoop);
  const nextCursor = hasNextPage ? encodeLoopCursor(loops[loops.length - 1]) : null;
  return { loops, hasNextPage, nextCursor };
}

/**
 * `loops_list` — cursor-paginated for the flat (non-ancestor) case; the
 * ancestor/lineage case returns its full descendant tree in one page
 * (unbounded, same as `listLoops`) since a lineage walk has no natural
 * "newest first" cursor to page through.
 */
export async function listLoopsPage(filters: ListLoopsPageFilters): Promise<LoopsPage> {
  if (filters.ancestor) {
    const loops = await listLoopLineage(filters.ancestor, filters.principal, filters.state ?? null, filters.kind ?? null);
    return { loops, hasNextPage: false, nextCursor: null };
  }
  return listLoopsForPrincipalPage(filters);
}

export interface LoopWithHistory {
  loop: LoopJson;
  events: LoopEventJson[];
}

/**
 * `GET /api/loops/:loopId` — the projection row plus its ordered event
 * history. Returns `null` when the loop doesn't exist OR belongs to a
 * different principal — indistinguishable on purpose (never reveal
 * whether a loopId exists to a caller who isn't allowed to see it, same
 * posture as `GET /api/operator-approvals`).
 */
export async function getLoopWithHistory(loopId: string, principal: string): Promise<LoopWithHistory | null> {
  const sql = getClient();

  const loopRows = (await sql`
    SELECT * FROM kernel.loops WHERE loop_id = ${loopId} AND principal = ${principal} LIMIT 1
  `) as unknown as RawLoopRow[];

  const loopRow = loopRows[0];
  if (!loopRow) return null;

  const eventRows = (await sql`
    SELECT * FROM kernel.loop_events WHERE loop_id = ${loopId} ORDER BY occurred_at ASC
  `) as unknown as RawLoopEventRow[];

  return {
    loop: serializeLoop(loopRow),
    events: eventRows.map(serializeLoopEvent),
  };
}
