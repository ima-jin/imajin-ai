/**
 * Evidence count per turn for the `/jin` usage feed (#1978, dashboard #1864).
 * Minimal by design — retrace (#1962) is where the evidence itself is read.
 *
 * Evidence rows link to a turn's usage row through their optional signed
 * `usageRef`; this counts non-revoked `agent.turn.evidence` rows per
 * `usageRef` for one subject. Backed by
 * idx_auth_attestations_turn_evidence_usage_ref
 * (migrations/0169_turn_evidence_indexes.sql).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, attestations } from '@/src/db';

const EVIDENCE_ATTESTATION_TYPE = 'agent.turn.evidence';

export async function countEvidenceByUsageRef(
  subjectDid: string,
  usageIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (usageIds.length === 0) return new Map();

  const usageRef = sql<string>`${attestations.payload}->>'usageRef'`;
  const rows: { usageRef: string; count: number }[] = await db
    .select({ usageRef, count: sql<number>`count(*)::int` })
    .from(attestations)
    .where(
      and(
        eq(attestations.type, EVIDENCE_ATTESTATION_TYPE),
        eq(attestations.subjectDid, subjectDid),
        isNull(attestations.revokedAt),
        inArray(usageRef, [...usageIds]),
      ),
    )
    .groupBy(usageRef);

  return new Map(rows.map((row) => [row.usageRef, row.count]));
}

/** Attach `evidenceCount` (0 when none) to each usage row, preserving order. */
export function attachEvidenceCounts<T extends { id: string }>(
  rows: readonly T[],
  counts: ReadonlyMap<string, number>,
): (T & { evidenceCount: number })[] {
  return rows.map((row) => ({ ...row, evidenceCount: counts.get(row.id) ?? 0 }));
}
