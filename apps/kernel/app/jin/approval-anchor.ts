/**
 * Deep-link anchor id (#2291) of one operator-approvals card on `/jin`. The
 * web-push notificationclick handler opens `/jin?proposalId=<id>` to this
 * card, and the "Provision app" form (#2559) links to it via `#<anchor>`.
 */
export function approvalCardAnchorId(proposalId: string): string {
  return `approval-${proposalId}`;
}

/**
 * Window event a raise-a-proposal form (e.g. the static-bearer knock form,
 * #2367) dispatches right after its POST succeeds, so the operator-approvals
 * panel re-fetches immediately and the freshly staged card exists for the
 * `#<anchor>` hand-off link instead of appearing on the next poll tick.
 */
export const APPROVALS_REFRESH_EVENT = 'jin:operator-approvals-refresh';

/** Ask the operator-approvals panel (if mounted) to re-fetch now. */
export function requestApprovalsRefresh(): void {
  globalThis.dispatchEvent(new Event(APPROVALS_REFRESH_EVENT));
}
