/**
 * Per-principal telemetry usage projection (#1677).
 *
 * The UI-facing read side of the telemetry ingestion pattern: every accepted
 * `telemetry.*` event lands a durable row in `kernel.audit_log` via the
 * generic `audit-log` reactor (#1140, wired in `packages/bus/src/config.ts`).
 * This module rolls those rows up per `(eventType, schema)` for one principal
 * DID, so a UI can answer "how much has this DID used, and of what kind"
 * without re-deriving anything from raw events.
 *
 * Split into pure aggregation + DB reads (mirrors `connector-telemetry.ts`'s
 * `buildConnectorTelemetryRollup` / `readConnectorTelemetry`), so the rollup
 * math is unit-testable without a database.
 *
 * `kernel.audit_log` has no Drizzle schema in apps/kernel (it is written via
 * raw SQL from packages/bus, per that package's AGENTS.md boundary), so reads
 * here go through `getClient()` directly — the same pattern
 * `app/api/admin/events/route.ts` already uses for `registry.system_events`.
 *
 * Two queries, deliberately different precision:
 *   - `readTelemetryUsageCounts`: exact COUNT/MIN/MAX per (eventType, schema)
 *     over the caller's FULL history — cheap, always accurate.
 *   - `readTelemetryUsageDataRows`: the `data` payload for the most recent
 *     `rowLimit` `telemetry.usage` rows, used to sum numeric fields. Bounded
 *     rather than exact — acceptable per #1677's own non-goal ("real-time
 *     streaming telemetry... batch/periodic is fine"), and avoids needing a
 *     per-schema field manifest to build dynamic SQL just to sum values.
 */
import { getClient } from '@imajin/db';
import { TELEMETRY_EVENT_TYPES, type TelemetryEventType } from './telemetry-ingest';

/** Default cap on rows read for the numeric-sum pass. See module doc. */
export const DEFAULT_TELEMETRY_USAGE_ROW_LIMIT = 1000;

// ── Row shapes read from the DB ─────────────────────────────────────────────

interface TelemetryUsageCountRow {
  eventType: string;
  schema: string;
  count: number;
  firstSeenAt: string | Date;
  lastSeenAt: string | Date;
}

interface TelemetryUsageDataRow {
  schema: string;
  data: Record<string, unknown> | null;
}

// ── Rollup output ────────────────────────────────────────────────────────────

export interface TelemetryUsageSchemaRollup {
  eventType: TelemetryEventType;
  schema: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * Sums of numeric `data` fields seen across the (possibly capped, see
   * module doc) sampled rows for this `(eventType, schema)`. Absent for
   * `telemetry.error` / `telemetry.lifecycle` — only `telemetry.usage` rows
   * are sampled for sums, since error/lifecycle payloads are not expected to
   * carry summable counters.
   */
  totals?: Record<string, number>;
}

export interface TelemetryUsageProjection {
  principal: string;
  totalCount: number;
  bySchema: TelemetryUsageSchemaRollup[];
}

// ── Pure aggregation ─────────────────────────────────────────────────────────

/** Sum numeric fields found in `data` across a set of rows, keyed by field name. */
function sumNumericFields(rows: readonly TelemetryUsageDataRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    if (!row.data) continue;
    for (const [key, value] of Object.entries(row.data)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }
  return totals;
}

/**
 * Combine the exact count rows with the (capped) usage data-sum rows into one
 * projection. Kept pure — no I/O — so it can be tested directly.
 */
export function buildTelemetryUsageProjection(
  principal: string,
  countRows: readonly TelemetryUsageCountRow[],
  usageDataRows: readonly TelemetryUsageDataRow[],
): TelemetryUsageProjection {
  // Group the capped usage data-sum rows by schema once, up front.
  const usageRowsBySchema = new Map<string, TelemetryUsageDataRow[]>();
  for (const row of usageDataRows) {
    const bucket = usageRowsBySchema.get(row.schema);
    if (bucket) {
      bucket.push(row);
    } else {
      usageRowsBySchema.set(row.schema, [row]);
    }
  }

  const bySchema: TelemetryUsageSchemaRollup[] = countRows
    .filter((row): row is TelemetryUsageCountRow & { eventType: TelemetryEventType } =>
      (TELEMETRY_EVENT_TYPES as readonly string[]).includes(row.eventType),
    )
    .map((row) => {
      const rollup: TelemetryUsageSchemaRollup = {
        eventType: row.eventType as TelemetryEventType,
        schema: row.schema,
        count: row.count,
        firstSeenAt: new Date(row.firstSeenAt).toISOString(),
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      };
      if (row.eventType === 'telemetry.usage') {
        const sampled = usageRowsBySchema.get(row.schema) ?? [];
        if (sampled.length > 0) {
          rollup.totals = sumNumericFields(sampled);
        }
      }
      return rollup;
    });

  const totalCount = bySchema.reduce((sum, row) => sum + row.count, 0);

  return { principal, totalCount, bySchema };
}

// ── DB reads ─────────────────────────────────────────────────────────────────

/** Exact per-(eventType, schema) counts and time range for one principal's full history. */
async function readTelemetryUsageCounts(principal: string): Promise<TelemetryUsageCountRow[]> {
  const sql = getClient();
  const rows = await sql`
    SELECT
      event_type AS "eventType",
      payload->>'schema' AS schema,
      COUNT(*)::int AS count,
      MIN(created_at) AS "firstSeenAt",
      MAX(created_at) AS "lastSeenAt"
    FROM kernel.audit_log
    WHERE event_type IN ('telemetry.usage', 'telemetry.error', 'telemetry.lifecycle')
      AND subject = ${principal}
      AND payload->>'schema' IS NOT NULL
    GROUP BY event_type, payload->>'schema'
  `;
  return rows as unknown as TelemetryUsageCountRow[];
}

/** The `data` payload of the most recent `rowLimit` `telemetry.usage` rows for one principal. */
async function readTelemetryUsageDataRows(
  principal: string,
  rowLimit: number,
): Promise<TelemetryUsageDataRow[]> {
  const sql = getClient();
  const rows = await sql`
    SELECT
      payload->>'schema' AS schema,
      payload->'data' AS data
    FROM kernel.audit_log
    WHERE event_type = 'telemetry.usage'
      AND subject = ${principal}
      AND payload->>'schema' IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ${rowLimit}
  `;
  return rows as unknown as TelemetryUsageDataRow[];
}

/**
 * Read the telemetry usage projection for `principal`. Caller is responsible
 * for authenticating/authorizing the request — this function trusts the DID
 * it is given (mirrors `readConnectorTelemetry`).
 */
export async function readTelemetryUsageProjection(
  principal: string,
  rowLimit: number = DEFAULT_TELEMETRY_USAGE_ROW_LIMIT,
): Promise<TelemetryUsageProjection> {
  const [countRows, usageDataRows] = await Promise.all([
    readTelemetryUsageCounts(principal),
    readTelemetryUsageDataRows(principal, rowLimit),
  ]);
  return buildTelemetryUsageProjection(principal, countRows, usageDataRows);
}
