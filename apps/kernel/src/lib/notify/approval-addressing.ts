/**
 * Who an `operator.approvals` row is addressed to (#2723).
 *
 * `operator.approvals.operator_did` is — and since #2723 is documented as —
 * "whose /jin Inbox this row lives in", NOT "the node operator". The column
 * name is a #2059 leftover; renaming it is a schema change, which waits for
 * the v0.8.18 baseline squash. Until then the meaning is carried here, in
 * one place:
 *
 *   - NODE-LEVEL kinds (gateway restart/config, `apps:provision`, vault,
 *     access, decision cards, exec …) are addressed to the node operator.
 *   - CONNECTOR proposals (`github:append`, `github:mutate`, and any other
 *     `<connector>:append|mutate|write` approval that carries an owner DID
 *     in `detail.ownerDid`) are addressed to that owner — whose own agent
 *     raised the proposal, so whose own /jin approves it. The node operator
 *     neither sees nor decides another principal's connector proposal
 *     (Ryan, 2026-10-07: "people can mind their own business").
 *
 * Deliberately pure and import-light (type-only `@imajin/auth`) so route
 * handlers, the service, the backlog re-address path and tests all share
 * exactly one definition of the split.
 */
import type { Identity } from '@imajin/auth';

/** `<connector>:<tier>` kinds that carry a write against a principal's own connector. */
const CONNECTOR_KIND_PATTERN = /^[a-z][a-z0-9-]*:(append|mutate|write)$/;

export interface AddressableApproval {
  kind: string;
  detail: Record<string, unknown> | null | undefined;
}

/**
 * The owner DID of a connector proposal, or `null` when the approval is
 * node-level (wrong kind shape, or no usable `detail.ownerDid`). A kind
 * that looks like a connector tier but carries no owner stays node-level:
 * with nobody to address it to, the operator is the only possible decider.
 */
export function connectorOwnerDid(approval: AddressableApproval): string | null {
  if (!CONNECTOR_KIND_PATTERN.test(approval.kind)) return null;
  const owner = approval.detail?.ownerDid;
  return typeof owner === 'string' && owner.startsWith('did:') ? owner : null;
}

/**
 * The DID whose Inbox the approval belongs in: the connector owner for a
 * connector proposal, otherwise `defaultDid` (the node operator for a fresh
 * request, the stored `operator_did` for an existing row).
 */
export function resolveApprovalAddressee(approval: AddressableApproval, defaultDid: string): string {
  return connectorOwnerDid(approval) ?? defaultDid;
}

/**
 * The DID a session reads/decides as — the REAL authenticated identity,
 * never an acting-for overlay. `null` for a delegated agent
 * (`X-Acting-For`): it has no Inbox and may not decide (#2359, same
 * invariant as `isOperatorIdentity`).
 */
export function inboxDidFor(identity: Identity): string | null {
  return identity.actingFor ? null : identity.id;
}
