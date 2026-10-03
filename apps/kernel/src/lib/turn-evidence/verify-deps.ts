/**
 * Production implementations of {@link VerifyDeps} (#1978) — the thin,
 * I/O-only layer under `./verify.ts`.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, attestations, auditLog } from '@/src/db';
import { resolveIssuerKey } from './ingest-deps';
import { toTurnEventRef, type AuditLogTurnRow } from './turn-event';
import type { StoredEvidenceRow, TurnEventRef, VerifyDeps } from './verify';

const EVIDENCE_ATTESTATION_TYPE = 'agent.turn.evidence';
const USAGE_ATTESTATION_TYPE = 'agent.turn.usage';

/** Upper bound on evidence rows one hash lookup will read (batch cap × a few colliding turns). */
export const VERIFY_ROW_LIMIT = 500;

async function findEvidenceByTurnOutputHash(hash: string): Promise<StoredEvidenceRow[]> {
  // Backed by idx_auth_attestations_turn_evidence_output_hash
  // (migrations/0169_turn_evidence_indexes.sql).
  const rows: StoredEvidenceRow[] = await db
    .select({
      id: attestations.id,
      issuerDid: attestations.issuerDid,
      subjectDid: attestations.subjectDid,
      type: attestations.type,
      contextId: attestations.contextId,
      contextType: attestations.contextType,
      payload: attestations.payload,
      signature: attestations.signature,
      issuedAt: attestations.issuedAt,
    })
    .from(attestations)
    .where(
      and(
        eq(attestations.type, EVIDENCE_ATTESTATION_TYPE),
        isNull(attestations.revokedAt),
        sql`${attestations.payload}->>'turnOutputHash' = ${hash}`,
      ),
    )
    .orderBy(asc(attestations.issuedAt))
    .limit(VERIFY_ROW_LIMIT);
  return rows;
}

async function resolveTurnEvent(turnEventId: string): Promise<TurnEventRef | null> {
  const [row]: AuditLogTurnRow[] = await db
    .select({
      id: auditLog.id,
      eventType: auditLog.eventType,
      issuer: auditLog.issuer,
      payload: auditLog.payload,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.id, turnEventId))
    .limit(1);
  return row ? toTurnEventRef(row) : null;
}

async function usageExists(id: string, agentDid: string): Promise<boolean> {
  const [row]: { id: string }[] = await db
    .select({ id: attestations.id })
    .from(attestations)
    .where(
      and(
        eq(attestations.id, id),
        eq(attestations.type, USAGE_ATTESTATION_TYPE),
        eq(attestations.subjectDid, agentDid),
        isNull(attestations.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export const productionVerifyDeps: VerifyDeps = {
  findEvidenceByTurnOutputHash,
  resolveIssuerKey,
  resolveTurnEvent,
  usageExists,
};
