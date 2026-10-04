/**
 * Seam to the #1970 mention-ledger turn event (#1978).
 *
 * #1978 is "blocked by" #1970: the per-turn signed event that commits *what
 * the agent said* (`inputHash`/`outputHash`) has not landed yet, so its id,
 * bus event type and payload field names are not final. Rather than invent
 * #1970's schema, this module is the single place that knows how to read a
 * turn event, and it degrades honestly: until a matching event exists,
 * linkage is reported as `unresolved` — never fabricated.
 *
 * The turn event is looked up by id in `kernel.audit_log` (the same read-only
 * mirror retrace uses for `bus_event` hops, see
 * `apps/kernel/src/lib/retrace/repository.ts`), restricted to
 * {@link TURN_EVENT_TYPES} so an unrelated bus event whose id someone cites
 * as `turnEventId` can never count as "the turn".
 *
 * FOLLOW-UP when #1970 lands: set {@link TURN_EVENT_TYPES} to its bus kind(s)
 * and confirm the two payload field names read in {@link toTurnEventRef}
 * (`outputHash`, `usageRef`); also add lookup-by-`outputHash` so a turn with
 * zero tool calls (hence zero evidence rows) still resolves on the verify
 * endpoint.
 */
import { normalizeHash } from '@imajin/auth';
import type { TurnEventRef } from './verify';

/** Bus event types accepted as a turn event. Placeholder until #1970 fixes its kind. */
export const TURN_EVENT_TYPES: readonly string[] = ['agent.turn'];

export interface AuditLogTurnRow {
  id: string;
  eventType: string;
  issuer: string;
  payload: unknown;
  createdAt: Date;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Map an audit-log row to the minimal turn view; `null` when it is not a turn event. */
export function toTurnEventRef(row: AuditLogTurnRow): TurnEventRef | null {
  if (!TURN_EVENT_TYPES.includes(row.eventType)) return null;
  const outputHash = stringField(row.payload, 'outputHash');
  return {
    id: row.id,
    eventType: row.eventType,
    issuer: row.issuer,
    occurredAt: row.createdAt,
    outputHash: outputHash === null ? null : normalizeHash(outputHash),
    usageRef: stringField(row.payload, 'usageRef'),
  };
}
