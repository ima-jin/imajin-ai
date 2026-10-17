/**
 * Registry-owned run → subject → usage read (#2290).
 * session_id is the external-ingest contract: it may contain a runId or a
 * publisher's sessionKey. Exact run ids win; shared session aliases are not
 * allocated speculatively. Each usage row is counted at most once.
 */
import { getClient } from '@imajin/db';

export interface RegistryRunCost {
  runId: string;
  loopId: string;
  refs: Record<string, unknown>;
  summary: string;
  state: string;
  startedAt: string;
  lastSeenAt: string;
  metered: { usd: number | null; turns: number } | null;
}

export interface RegistrySubjectCost {
  ref: string;
  runCount: number;
  meteredUsd: number | null;
}

export interface RegistrySpend {
  currency: 'USD';
  windowFrom: string;
  windowTo: string;
  runs: RegistryRunCost[];
  issues: RegistrySubjectCost[];
  prs: RegistrySubjectCost[];
}

interface SpendRow {
  run_id: string;
  loop_id: string;
  refs: Record<string, unknown>;
  summary: string;
  state: string;
  started_at: Date | string;
  last_seen_at: Date | string;
  usd: string | null;
  turns: string | number;
}

export function groupRegistrySubjects(runs: RegistryRunCost[], key: 'issue' | 'pr'): RegistrySubjectCost[] {
  const groups = new Map<string, RegistrySubjectCost>();
  const unknown = new Set<string>();
  for (const run of runs) {
    const ref = run.refs[key];
    if (typeof ref !== 'string' || !ref) continue;
    const group = groups.get(ref) ?? { ref, runCount: 0, meteredUsd: null };
    group.runCount++;
    const usd = run.metered?.usd;
    if (usd !== null && usd !== undefined) group.meteredUsd = (group.meteredUsd ?? 0) + usd;
    else unknown.add(ref);
    groups.set(ref, group);
  }
  return [...groups.values()].map((group) => ({
    ...group, meteredUsd: unknown.has(group.ref) ? null : group.meteredUsd,
  })).sort((a, b) => a.ref.localeCompare(b.ref));
}

/** No Warp/Gateway calls: the entire join is scoped on both sides to principal. */
export async function readRegistrySpend(principal: string, from: string, to: string): Promise<RegistrySpend> {
  const sql = getClient();
  const rows = await sql`
    WITH scoped AS (
      SELECT *, COALESCE(NULLIF(refs->>'runId', ''), loop_id) AS run_id FROM kernel.loops
      WHERE principal = ${principal}
        AND (COALESCE(refs->>'runId', '') <> '' OR COALESCE(refs->>'sessionKey', '') <> '')
    ), runs AS (
      SELECT DISTINCT ON (run_id) * FROM scoped
      ORDER BY run_id, (kind = 'warp.run') DESC, last_seen_at DESC, loop_id
    ), subjects AS (
      SELECT run_id,
        CASE WHEN COUNT(DISTINCT NULLIF(refs->>'issue', '')) = 1 THEN MIN(NULLIF(refs->>'issue', '')) END AS issue,
        CASE WHEN COUNT(DISTINCT NULLIF(refs->>'pr', '')) = 1 THEN MIN(NULLIF(refs->>'pr', '')) END AS pr
      FROM scoped GROUP BY run_id
    ), aliases AS (
      SELECT DISTINCT run_id, refs->>'sessionKey' AS session_key FROM scoped
      WHERE COALESCE(refs->>'sessionKey', '') <> ''
      UNION
      SELECT s.run_id, e.payload->'refs'->>'sessionKey' AS session_key
      FROM scoped s JOIN kernel.loop_events e ON e.loop_id = s.loop_id
      WHERE e.principal = ${principal}
        AND COALESCE(e.payload->'refs'->>'sessionKey', '') <> ''
        AND COALESCE(e.payload->'refs'->>'runId', s.run_id) = s.run_id
    ), unique_aliases AS (
      SELECT session_key, MIN(run_id) AS run_id FROM aliases
      GROUP BY session_key HAVING COUNT(DISTINCT run_id) = 1
    ), matched AS (
      SELECT u.id, u.cost_usd, COALESCE(exact.run_id, alias.run_id) AS run_id
      FROM usage.incurred u
      LEFT JOIN runs exact ON exact.run_id = u.session_id
      LEFT JOIN unique_aliases alias ON alias.session_key = u.session_id
      WHERE u.principal_did = ${principal}
        AND u.created_at >= ${from}::timestamptz AND u.created_at < ${to}::timestamptz
        AND u.status IS DISTINCT FROM 'error'
    ), costs AS (
      SELECT run_id,
        CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) ELSE NULL END AS usd,
        COUNT(*) AS turns
      FROM matched WHERE run_id IS NOT NULL GROUP BY run_id
    )
    SELECT r.run_id, r.loop_id,
      (r.refs - 'issue' - 'pr') || jsonb_strip_nulls(jsonb_build_object('issue', s.issue, 'pr', s.pr)) AS refs,
      r.summary, r.state, r.started_at, r.last_seen_at,
      c.usd, COALESCE(c.turns, 0) AS turns
    FROM runs r JOIN subjects s ON s.run_id = r.run_id LEFT JOIN costs c ON c.run_id = r.run_id
    WHERE (r.last_seen_at >= ${from}::timestamptz AND r.started_at < ${to}::timestamptz)
       OR c.turns > 0
    ORDER BY r.last_seen_at DESC, r.run_id
  ` as unknown as SpendRow[];
  const runs = rows.map((row): RegistryRunCost => ({
    runId: row.run_id,
    loopId: row.loop_id,
    refs: row.refs,
    summary: row.summary,
    state: row.state,
    startedAt: new Date(row.started_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    metered: Number(row.turns) > 0 ? { usd: row.usd === null ? null : Number(row.usd), turns: Number(row.turns) } : null,
  }));
  return { currency: 'USD', windowFrom: from, windowTo: to, runs, issues: groupRegistrySubjects(runs, 'issue'), prs: groupRegistrySubjects(runs, 'pr') };
}

/** Membership is independent of the spend window and list pagination. */
export async function registeredRunIds(principal: string, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const sql = getClient();
  const rows = await sql`
    SELECT DISTINCT wanted.run_id FROM unnest(${runIds}::text[]) AS wanted(run_id)
    WHERE EXISTS (
      SELECT 1 FROM kernel.loops l WHERE l.principal = ${principal}
        AND (l.refs->>'runId' = wanted.run_id OR l.loop_id = wanted.run_id)
    )
  ` as unknown as { run_id: string }[];
  return new Set(rows.map((row) => row.run_id));
}

/** Legacy fallback cannot consume session rows already claimed by registry refs. */
export async function unregisteredSessionIds(principal: string, sessionIds: string[]): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const sql = getClient();
  const rows = await sql`
    SELECT DISTINCT u.session_id FROM unnest(${sessionIds}::text[]) AS u(session_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM kernel.loops l WHERE l.principal = ${principal}
        AND (l.refs->>'runId' = u.session_id OR l.refs->>'sessionKey' = u.session_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.loop_events e WHERE e.principal = ${principal}
        AND e.payload->'refs'->>'sessionKey' = u.session_id
    )
  ` as unknown as { session_id: string }[];
  return rows.map((row) => row.session_id);
}
