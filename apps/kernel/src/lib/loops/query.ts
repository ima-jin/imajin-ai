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
