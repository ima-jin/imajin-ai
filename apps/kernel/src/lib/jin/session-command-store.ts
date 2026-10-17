import { createHash } from 'node:crypto';
import { getClient } from '@imajin/db';
import { sql } from 'drizzle-orm';
import { db } from '@/src/db';
import type { SessionCommandFrame, SessionAttestation, SessionOutcome } from './session-command-contract';

export function sessionEventId(kind: string, key: string): string {
  return `session:${kind}:${createHash('sha256').update(key).digest('hex')}`;
}
export async function readSessionLoopIdentity(loopId: string, principal: string) {
  const client = getClient();
  const rows = await client`
    SELECT loop_id,parent_loop_id FROM kernel.loops
    WHERE loop_id=${loopId} AND principal=${principal} LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface StoredSessionEvent {
  id: string;
  loop_id: string;
  issuer: string;
  principal: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The caller's transaction also owns the approval CAS. A conflict MUST roll it back. */
export async function insertSessionCommand(
  tx: Pick<typeof db, 'execute'>,
  loopId: string,
  frame: SessionCommandFrame,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    INSERT INTO kernel.loop_events (id,loop_id,type,issuer,principal,payload,occurred_at)
    VALUES (${sessionEventId('command', frame.commandId)},${loopId},'loop.command.queued',
      ${frame.issuer},${frame.principal},${JSON.stringify({ commandId: frame.commandId, command: frame })}::jsonb,${frame.issuedAt}::timestamptz)
    ON CONFLICT (id) DO NOTHING RETURNING id
  `);
  return (rows as unknown as unknown[]).length === 1;
}

export async function getSessionEvent(kind: string, key: string, principal: string): Promise<StoredSessionEvent | null> {
  const client = getClient();
  const rows = await client`
    SELECT id,loop_id,type,issuer,principal,payload FROM kernel.loop_events
    WHERE id=${sessionEventId(kind, key)} AND principal=${principal} LIMIT 1
  `;
  return rows[0] as unknown as StoredSessionEvent ?? null;
}

export async function appendSessionEvent(
  kind: string, key: string, loopId: string, type: string, issuer: string, principal: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const client = getClient();
  const rows = await client`
    INSERT INTO kernel.loop_events (id,loop_id,type,issuer,principal,payload,occurred_at)
    VALUES (${sessionEventId(kind, key)},${loopId},${type},${issuer},${principal},${JSON.stringify(payload)}::jsonb,NOW())
    ON CONFLICT (id) DO NOTHING RETURNING id
  `;
  return rows.length === 1;
}

export async function readLoopCommandProof(loopId: string, principal: string) {
  const client = getClient();
  const loops = await client`
    SELECT loop_id,principal,state,parent_loop_id,finished_at,kind FROM kernel.loops
    WHERE loop_id=${loopId} AND principal=${principal} LIMIT 1
  `;
  const proofs = await client`
    SELECT type,issuer,payload->'publisherProof' AS proof,payload->'spawnProof' AS spawn_proof
    FROM kernel.loop_events WHERE loop_id=${loopId} AND principal=${principal}
      AND type IN ('loop.started','loop.progress','loop.blocked','loop.finished')
    ORDER BY occurred_at,id LIMIT 1001
  `;
  return { loop: loops[0], proofs };
}

export async function readBindingEvents(principal: string, approvalId: string) {
  const client = getClient();
  return client`
    SELECT payload FROM kernel.loop_events
    WHERE principal=${principal} AND type='loop.approval.bound'
      AND payload->'attestation'->'payload'->>'approvalId'=${approvalId}
    LIMIT 3
  `;
}

/** A unique result claim and any child projection commit together, never two conflicting children. */
export async function persistSessionOutcome(
  command: SessionCommandFrame, attestation: SessionAttestation, outcome: SessionOutcome, parentLoopId: string,
): Promise<boolean> {
  const client = getClient();
  return client.begin(async tx => {
    const claimed = await tx`
      INSERT INTO kernel.loop_events (id,loop_id,type,issuer,principal,payload,occurred_at)
      VALUES (${sessionEventId('result', command.commandId)},${parentLoopId},${outcome.eventType},${command.to},${command.principal},
        ${JSON.stringify({ ...outcome, attestation })}::jsonb,NOW())
      ON CONFLICT (id) DO NOTHING RETURNING id
    `;
    if (claimed.length === 0) return false;
    if (command.type !== 'session.spawn' || outcome.outcome !== 'completed') return true;
    const childLoopId = outcome.childLoopId!;
    const owners = await tx`
      INSERT INTO kernel.loops (loop_id,kind,principal,parent_loop_id,state,summary,last_event_type,started_at,last_seen_at)
      VALUES (${childLoopId},'openclaw.subagent',${command.principal},${parentLoopId},'running','Spawn attested','loop.started',NOW(),NOW())
      ON CONFLICT (loop_id) DO UPDATE SET loop_id=kernel.loops.loop_id
      WHERE kernel.loops.principal=EXCLUDED.principal
        AND kernel.loops.parent_loop_id=EXCLUDED.parent_loop_id
      RETURNING loop_id
    `;
    if (owners.length !== 1) throw new Error('Child lineage conflict');
    await tx`
      INSERT INTO kernel.loop_events (id,loop_id,type,issuer,principal,payload,occurred_at)
      VALUES (${sessionEventId('spawn', command.commandId)},${childLoopId},'loop.started',${command.to},${command.principal},
        ${JSON.stringify({ spawnProof: { command, attestation } })}::jsonb,NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    return true;
  });
}
