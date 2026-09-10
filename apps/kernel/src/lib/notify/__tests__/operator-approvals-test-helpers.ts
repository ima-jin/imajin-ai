/**
 * Shared fixtures for the operator-approvals test suites (#2059).
 *
 * Kept in one place so the decision route, list route, and service tests
 * never redefine the same operator/agent/proposal identities with subtly
 * different shapes (SonarCloud duplicated-lines guard on new code).
 */
import type { Identity } from '@imajin/auth';

export const OPERATOR_DID = 'did:imajin:ryan-operator';
export const OTHER_HUMAN_DID = 'did:imajin:someone-else';
export const AGENT_DID = 'did:imajin:jin-agent';
export const PROPOSAL_ID = 'opap_test123';

/** The operator, authenticated directly — the only identity that may decide. */
export function operatorIdentity(): Identity {
  return { id: OPERATOR_DID, scope: 'actor', subtype: 'human' };
}

/** A different, non-operator human — authenticated, but not the operator. */
export function otherHumanIdentity(): Identity {
  return { id: OTHER_HUMAN_DID, scope: 'actor', subtype: 'human' };
}

/**
 * `@jin` (the agent) holding `X-Acting-For: <operatorDid>` — the exact
 * shape the load-bearing auth rule must reject: `id` is the agent's own
 * DID, `actingFor` names the operator.
 */
export function agentActingForOperatorIdentity(): Identity {
  return { id: AGENT_DID, scope: 'actor', subtype: 'agent', actingFor: OPERATOR_DID, actingForRole: 'agent' };
}

export function pendingApprovalCard(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: PROPOSAL_ID,
    operatorDid: OPERATOR_DID,
    source: 'system-agent',
    kind: 'system-agent:restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: [] as string[],
    detail: null,
    contentHash: null,
    status: 'pending' as const,
    decision: null,
    appliedAt: null,
    createdAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}
