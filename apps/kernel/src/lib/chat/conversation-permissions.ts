/**
 * Client-side conversation permission predicates (#1651).
 *
 * These mirror gates the API already enforces. The point is not security — the
 * server is the authority — it is that the UI must never offer an action the
 * API will refuse with a 403. Keeping the predicate here (pure, no React, no
 * fetch) means the visibility rule is testable without rendering anything.
 */

/** The shape both the list row and the detail view have in hand. */
export interface DeletableConversation {
  createdBy?: string | null;
}

/**
 * Only the creator may delete a conversation.
 *
 * Mirrors `DELETE /chat/api/conversations/:id`, which returns 403 unless
 * `conv.createdBy === effectiveDid`. Everyone else keeps the non-destructive
 * leave/hide path, so a missing DID on either side resolves to `false` rather
 * than falling through to a permissive default.
 */
export function canDeleteConversation(
  conversation: DeletableConversation | null | undefined,
  viewerDid: string | null | undefined,
): boolean {
  const createdBy = conversation?.createdBy;
  if (!createdBy || !viewerDid) return false;
  return createdBy === viewerDid;
}
