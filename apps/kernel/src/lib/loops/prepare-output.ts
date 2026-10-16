import type { JsonValue, LoopEventPayload, StoredLoopOutput } from '@imajin/bus';
import type { LoopEnvelope, LoopLifecycleType } from './types';
import { redactLoopJson } from './output-redaction';
import { putLoopOutputArtifact } from './artifact-store';
import { getClient } from '@imajin/db';
import { canonicalize } from '@imajin/auth';

export const MAX_INLINE_LOOP_OUTPUT_BYTES = 16384;

export function redactLoopEnvelope(payload: LoopEnvelope): LoopEnvelope {
  return redactLoopJson(payload as unknown as JsonValue) as unknown as LoopEnvelope;
}

/** Atomic owner reservation closes the check/write race before any artifact or bus write.
 * A later storage/publish failure may leave this reserved projection; retries by the
 * same principal are safe and another principal can never take it over.
 */
export async function reserveLoopOwnership(type: LoopLifecycleType, payload: LoopEnvelope): Promise<boolean> {
  const sql = getClient();
  const rows = await sql`
    INSERT INTO kernel.loops
      (loop_id, kind, principal, parent_loop_id, refs, state, summary, last_event_type, started_at, last_seen_at, finished_at)
    VALUES
      (${payload.loopId}, ${payload.kind}, ${payload.principal}, ${payload.parentLoopId ?? null},
       ${JSON.stringify(payload.refs ?? {})}::jsonb, ${payload.state}, ${payload.summary}, ${type},
       ${payload.at}::timestamptz, ${payload.at}::timestamptz, ${type === 'loop.finished' ? payload.at : null}::timestamptz)
    ON CONFLICT (loop_id) DO UPDATE SET loop_id = EXCLUDED.loop_id
      WHERE kernel.loops.principal = EXCLUDED.principal
    RETURNING loop_id
  `;
  return rows.length === 1;
}

/** Called after redaction and ownership reservation. */
export async function prepareLoopOutput(payload: LoopEnvelope): Promise<LoopEventPayload> {
  if (payload.output === undefined) return payload;
  const content = canonicalize(payload.output);
  if (Buffer.byteLength(content, 'utf8') <= MAX_INLINE_LOOP_OUTPUT_BYTES) return payload;
  const artifactRef = await putLoopOutputArtifact(payload.loopId, payload.principal, payload.output);
  const output: StoredLoopOutput = {
    kind: payload.output.kind,
    artifactRef,
    // Bounded Unicode-safe preview; the artifact retains the complete JSON.
    preview: Array.from(content).slice(0, 256).join(''),
    truncated: true,
  };
  return { ...payload, output };
}
