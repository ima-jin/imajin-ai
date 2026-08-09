import { nodeUrl } from '../http/node-url';

/**
 * Human-facing copy for a write held pending approval (#1582).
 *
 * The previous wording told the agent to "Approve at
 * /github/api/confirm/<id>". That path is a POST + owner-DID-auth API, not a
 * page — the first external user's client faithfully relayed it, he opened it
 * in a browser, and got a 405. The approval surface that actually exists for a
 * human is the `/jin` dashboard's pending-proposals panel (#1429).
 *
 * Three things this copy must do, all learned from that report:
 *  1. Name `/jin` as the human door, and the confirm path as an API.
 *  2. Emit a FULLY-QUALIFIED URL. The message crosses into a remote MCP client
 *     that has no idea which host this node is on; a bare `/jin` makes the
 *     agent guess. `nodeUrl()` is the same origin the discovery documents and
 *     browser redirects advertise (#1608, #1614).
 *  3. State the TTL/batch option. The reporting user had 11 queued writes;
 *     approving once with a 5m/24h window is the intended flow, and an agent
 *     that does not know it exists will ask for 11 separate approvals.
 *
 * This lives in its own leaf module (like `./entities` and `./constants`) so
 * the copy can be asserted on without dragging in the DB, vault, and bus.
 *
 * ── `reason` (#1716) ────────────────────────────────────────────────────────
 * A write can land in 'pending' for two very different reasons:
 *  - 'no_grant'     — no live approval window exists at all; approving now
 *                      (optionally with a 5m/24h TTL) is exactly what unblocks it.
 *  - 'rate_limited' — a live approval window IS already active, but a write
 *                      ceiling (global or per-tool) tripped anyway (#1371 — this
 *                      trips even inside a live window, by design). Approving
 *                      this proposal opens ANOTHER window; it does not lift the
 *                      ceiling. Without this distinction the agent/human cannot
 *                      tell "no window" from "window ignored", and reads every
 *                      re-propose as proof approving "did nothing" (#1716).
 */
export type PendingReason = 'no_grant' | 'rate_limited';

export function pendingApprovalMessage(
  proposalId: string,
  reason: PendingReason = 'no_grant',
  limitLabel?: string | null,
): string {
  const host = nodeUrl();

  if (reason === 'rate_limited') {
    const ceiling = limitLabel != null ? ` (${limitLabel})` : '';
    return (
      `Action proposed (proposalId: ${proposalId}). ` +
      `NOTE: an approval window is already active for this write — this is NOT a missing-approval ` +
      `case. It was re-proposed because a write-rate ceiling${ceiling} was hit; that ceiling applies ` +
      `even inside a live window and is not lifted by approving again. ` +
      `Approving this proposal in the Imajin dashboard (${host}/jin) opens ANOTHER window but will ` +
      `NOT let the write through any sooner — the existing window already covers it. ` +
      `Simply wait for the ceiling's rolling window to clear (up to 1 hour) and retry the same tool ` +
      `call; no further approval should be needed once it does. ` +
      `(Programmatic status check: GET/POST ${host}/github/api/confirm/${proposalId} with owner DID auth.)`
    );
  }

  return (
    `Action proposed (proposalId: ${proposalId}). This write is held pending your approval. ` +
    `Tell the human to approve it in their Imajin dashboard: ${host}/jin — ` +
    `the pending-proposals panel lists this proposal with Yes / 5m / 24h buttons. ` +
    `Choosing 5m or 24h opens an approval window that covers further writes of the same ` +
    `kind, so a batch of queued writes only needs approving once. ` +
    `Then retry this tool call. ` +
    `(Programmatic alternative: POST ${host}/github/api/confirm/${proposalId} with owner DID auth. ` +
    `That path is an API, not a page — opening it in a browser returns 405.)`
  );
}
