/**
 * Warn-only surface observations (#2405). Both reads are always scoped to the
 * authenticated effective principal; a loop filter never broadens that scope.
 */
import { getClient } from '@imajin/db';
import { serializeLoopEvent, type LoopEventJson, type RawLoopEventRow } from './serialize';

export interface ListSurfaceFilters {
  principal: string;
  loopId?: string | null;
  limit?: number;
}

interface RawSurfaceLeaseRow {
  surface: string;
  loop_id: string;
  principal: string;
  issuer: string;
  signature: Record<string, unknown>;
  signed_payload: Record<string, unknown>;
  acquired_at: string | Date;
  expires_at: string | Date;
  heartbeat_at: string | Date;
  released_at: string | Date | null;
  updated_at: string | Date;
}

export interface SurfaceLeaseJson {
  surface: string;
  loopId: string;
  principal: string;
  issuer: string;
  signature: Record<string, unknown>;
  signedPayload: Record<string, unknown>;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt: string | null;
  updatedAt: string;
}

export interface LoopSurfacesJson {
  leases: SurfaceLeaseJson[];
  conflicts: LoopEventJson[];
  warnOnly: true;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return 50;
  return Math.min(200, Math.trunc(limit));
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function serializeLease(row: RawSurfaceLeaseRow): SurfaceLeaseJson {
  return {
    surface: row.surface,
    loopId: row.loop_id,
    principal: row.principal,
    issuer: row.issuer,
    signature: row.signature,
    signedPayload: row.signed_payload,
    acquiredAt: toIso(row.acquired_at),
    expiresAt: toIso(row.expires_at),
    heartbeatAt: toIso(row.heartbeat_at),
    releasedAt: row.released_at === null ? null : toIso(row.released_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Only live holdings and recent conflict observations belonging to this principal. */
export async function listLoopSurfaces(filters: ListSurfaceFilters): Promise<LoopSurfacesJson> {
  const sql = getClient();
  const limit = boundedLimit(filters.limit);
  const loopId = filters.loopId || null;

  const leases = (await sql`
    SELECT * FROM kernel.surface_lease
    WHERE principal = ${filters.principal}
      AND released_at IS NULL
      AND expires_at > now()
      AND (${loopId}::text IS NULL OR loop_id = ${loopId})
    ORDER BY updated_at DESC, surface ASC
    LIMIT ${limit}
  `) as unknown as RawSurfaceLeaseRow[];

  const conflicts = (await sql`
    SELECT * FROM kernel.loop_events
    WHERE principal = ${filters.principal}
      AND type = 'surface.conflicted'
      AND (
        ${loopId}::text IS NULL
        OR payload->>'loopId' = ${loopId}
        OR payload->'refs'->>'conflictingLoopId' = ${loopId}
      )
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${limit}
  `) as unknown as RawLoopEventRow[];

  return {
    leases: leases.map(serializeLease),
    conflicts: conflicts.map(serializeLoopEvent),
    warnOnly: true,
  };
}
