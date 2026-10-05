/**
 * Deep-link anchor id (#2291) of one operator-approvals card on `/jin`. The
 * web-push notificationclick handler opens `/jin?proposalId=<id>` to this
 * card, and the "Provision app" form (#2559) links to it via `#<anchor>`.
 */
export function approvalCardAnchorId(proposalId: string): string {
  return `approval-${proposalId}`;
}
