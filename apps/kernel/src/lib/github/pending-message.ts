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
 */
export function pendingApprovalMessage(proposalId: string): string {
  const host = nodeUrl();

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
