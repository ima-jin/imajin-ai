/**
 * Canonical per-asset WRITE (content update) authorization (#1170 Stage 2).
 *
 * Pure, synchronous core — the write-side analogue of canReadAsset
 * (read-access.ts). Shared by the PUT /media/api/assets/[id]/content route and
 * the media_update MCP tool so they make the SAME decision.
 *
 * v1 is deliberately OWNER-ONLY: the requester must own the asset. This is the
 * single seam where a future delegated write-grant model (e.g. trust-graph
 * `allowedWriters`) would be layered on — kept separate from canReadAsset so
 * that a read grant can NEVER imply a write grant (read != write). Expanding to
 * delegated cross-DID writes is intentionally out of scope here (it pulls in the
 * confused-deputy surface and GC #1165 as a precondition for high-volume use).
 */

export interface AssetWriteSubject {
  ownerDid: string;
  /** assets.immutable (locked assets cannot be edited). */
  immutable: boolean | null;
}

export type WriteDecision =
  | { allowed: true }
  | { allowed: false; code: 'forbidden' | 'immutable'; reason: string };

/**
 * Decide whether `requesterDid` (null = unauthenticated) may overwrite the
 * asset's content.
 *
 *   owner      → allowed (unless the asset is immutable)
 *   non-owner  → forbidden (no delegated write grants in v1)
 *
 * Owner is checked BEFORE immutability so a non-owner never learns whether an
 * asset is locked — matching the PUT /content route's check order.
 */
export function canWriteAssetContent(
  subject: AssetWriteSubject,
  requesterDid: string | null,
): WriteDecision {
  if (!requesterDid || requesterDid !== subject.ownerDid) {
    return { allowed: false, code: 'forbidden', reason: 'Private asset — owner only' };
  }
  if (subject.immutable) {
    return { allowed: false, code: 'immutable', reason: 'Immutable asset — content cannot be edited' };
  }
  return { allowed: true };
}
