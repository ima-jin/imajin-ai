/**
 * Vault revoke tiers (#2247) — shared between the `/jin` canvas's vault
 * registry entry (`operator-approvals-panel.tsx`), the `vault-proposals`
 * route's own summary copy (`app/jin/api/vault-proposals/route.ts`), and
 * the execution bridge (`approvals-execution.ts`), so the human-readable
 * label for a tier can never drift between the proposal-creation summary
 * and the approval-card copy.
 *
 * Framework-agnostic (no React, no server-only imports) so both a
 * `'use client'` component and a server route can import it directly.
 */
export type VaultRevokeTier = 'withdraw' | 'tombstone' | 'destroy';

/** Human label for a vault:revoke tier. */
export function revokeTierLabel(tier: string): string {
  if (tier === 'destroy') return 'Destroy';
  if (tier === 'tombstone') return 'Tombstone';
  return 'Withdraw';
}
