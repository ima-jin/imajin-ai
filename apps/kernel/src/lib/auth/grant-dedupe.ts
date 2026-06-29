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
    if (aActive && !curActive) {
      bySubject.set(a.subjectDid, a);
    } else if (aActive === curActive && (a.issuedAt?.getTime() ?? 0) > (cur.issuedAt?.getTime() ?? 0)) {
      bySubject.set(a.subjectDid, a);
    }
  }
  return [...bySubject.values()];
}
