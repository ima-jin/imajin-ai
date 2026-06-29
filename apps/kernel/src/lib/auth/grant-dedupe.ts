/**
 * Pure grant-dedup helper for the unified integrations read model (#1171).
 *
 * Kept DB-free (no `@/src/db` import) so it is unit-testable in isolation —
 * vitest does not resolve the `@/*` path alias.
 */

export interface AttestationRow {
  id: string;
  subjectDid: string;
  payload: unknown;
  issuedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * One grant per subject DID: prefer an active (un-revoked) attestation, then the
 * most recently issued. Defensive hygiene — /oauth/authorize already reuses an
 * active grant rather than inserting duplicates, but other write paths (or a
 * revoke-then-reauthorize) can leave stragglers.
 */
export function dedupeAttestationsBySubject(atts: AttestationRow[]): AttestationRow[] {
  const bySubject = new Map<string, AttestationRow>();
  for (const a of atts) {
    const cur = bySubject.get(a.subjectDid);
    if (!cur) {
      bySubject.set(a.subjectDid, a);
      continue;
    }
    const curActive = !cur.revokedAt;
    const aActive = !a.revokedAt;
    const aMoreRecent = (a.issuedAt?.getTime() ?? 0) > (cur.issuedAt?.getTime() ?? 0);
    // Replace cur when a is preferable: active beats revoked, then most-recent wins within the same active-state.
    const aWins = (aActive && !curActive) || (aActive === curActive && aMoreRecent);
    if (aWins) {
      bySubject.set(a.subjectDid, a);
    }
  }
  return [...bySubject.values()];
}
