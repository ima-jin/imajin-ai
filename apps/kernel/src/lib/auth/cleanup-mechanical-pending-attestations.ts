/**
 * Bulk-cleanup for stale pending mechanical attestations (#1825).
 *
 * #1822 fixed the source (`emitSessionAttestation` no longer leaves
 * `attestation_status` defaulted to `'pending'`) and added a query-level
 * filter so mechanical types never appear in the untyped
 * "pending your countersignature" view going forward. Neither of those
 * touches the ~1,052 `session.created` rows that were already written with
 * `attestation_status = 'pending'` before the fix shipped — this module
 * resolves those historical rows.
 *
 * Terminal state chosen: `attestation_status = NULL`, not `'bilateral'`,
 * `'declined'`, or `'expired'`. `NULL` is the existing schema convention for
 * "not a countersignable attestation" — it's exactly what
 * `POST /auth/api/attestations` already assigns to any legacy (non-bilateral,
 * no `author_jws`) attestation, and what #1822 now assigns to newly-created
 * `session.created` rows. Reusing that convention for the historical backlog
 * keeps every `session.created` row — past and future — in the same state,
 * rather than introducing a fourth, one-off meaning for "resolved".
 *
 * Idempotent: only rows still `attestation_status = 'pending'` are touched,
 * so re-running after a successful pass updates zero rows.
 */
import { and, eq } from 'drizzle-orm';
import { db, attestations } from '@/src/db';
import { MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';

export interface MechanicalPendingCleanupResult {
  type: string;
  matched: number;
}

/** Count stale pending rows per mechanical type, without writing anything. */
export async function countMechanicalPendingAttestations(): Promise<MechanicalPendingCleanupResult[]> {
  const results: MechanicalPendingCleanupResult[] = [];
  for (const type of MECHANICAL_ATTESTATION_TYPES) {
    const rows = await db
      .select({ id: attestations.id })
      .from(attestations)
      .where(and(eq(attestations.type, type), eq(attestations.attestationStatus, 'pending')));
    results.push({ type, matched: rows.length });
  }
  return results;
}

/**
 * Resolve stale pending mechanical attestations by clearing
 * `attestation_status` to `NULL` (see module doc for why `NULL`).
 *
 * Idempotent and safe to re-run — the WHERE clause only ever matches rows
 * still sitting at `'pending'`.
 */
export async function cleanupMechanicalPendingAttestations(): Promise<MechanicalPendingCleanupResult[]> {
  const results: MechanicalPendingCleanupResult[] = [];
  for (const type of MECHANICAL_ATTESTATION_TYPES) {
    const updated = await db
      .update(attestations)
      .set({ attestationStatus: null })
      .where(and(eq(attestations.type, type), eq(attestations.attestationStatus, 'pending')))
      .returning({ id: attestations.id });
    results.push({ type, matched: updated.length });
  }
  return results;
}
