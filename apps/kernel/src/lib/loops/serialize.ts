/**
 * Kernel loop registry (#2295) — maps raw `kernel.loops` / `kernel.loop_events`
 * rows (snake_case, as returned by the raw-SQL `postgres.js` client used for
 * the recursive lineage query) onto the camelCase JSON shape the
 * `GET /api/loops` / `GET /api/loops/:loopId` routes return.
 */

export interface LoopJson {
  loopId: string;
  kind: string;
  principal: string;
  parentLoopId: string | null;
  refs: Record<string, unknown>;
  state: string;
  summary: string;
  lastEventType: string;
  startedAt: string;
  lastSeenAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoopEventJson {
  id: string;
  loopId: string;
  type: string;
  issuer: string;
  principal: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

/** Raw row shape as returned by `sql\`SELECT * FROM kernel.loops\`` (snake_case columns). */
export interface RawLoopRow {
  loop_id: string;
  kind: string;
  principal: string;
  parent_loop_id: string | null;
  refs: Record<string, unknown> | null;
  state: string;
  summary: string;
  last_event_type: string;
  started_at: string | Date;
  last_seen_at: string | Date;
  finished_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Raw row shape as returned by `sql\`SELECT * FROM kernel.loop_events\`` (snake_case columns). */
export interface RawLoopEventRow {
  id: string;
  loop_id: string;
  type: string;
  issuer: string;
  principal: string;
  payload: Record<string, unknown> | null;
  occurred_at: string | Date;
  created_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

export function serializeLoop(row: RawLoopRow): LoopJson {
  return {
    loopId: row.loop_id,
    kind: row.kind,
    principal: row.principal,
    parentLoopId: row.parent_loop_id,
    refs: row.refs ?? {},
    state: row.state,
    summary: row.summary,
    lastEventType: row.last_event_type,
    startedAt: toIso(row.started_at),
    lastSeenAt: toIso(row.last_seen_at),
    finishedAt: toIsoOrNull(row.finished_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function serializeLoopEvent(row: RawLoopEventRow): LoopEventJson {
  return {
    id: row.id,
    loopId: row.loop_id,
    type: row.type,
    issuer: row.issuer,
    principal: row.principal,
    payload: row.payload ?? {},
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
  };
}
