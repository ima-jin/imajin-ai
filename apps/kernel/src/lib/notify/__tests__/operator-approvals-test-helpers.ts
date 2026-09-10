/**
 * Shared fixtures for the operator-approvals test suites (#2059).
 *
 * Kept in one place so the decision route, list route, and service tests
 * never redefine the same operator/agent/proposal identities with subtly
 * different shapes (SonarCloud duplicated-lines guard on new code).
 */
import { createHash } from 'node:crypto';
import type { Identity } from '@imajin/auth';

export const OPERATOR_DID = 'did:imajin:ryan-operator';
export const OTHER_HUMAN_DID = 'did:imajin:someone-else';
export const AGENT_DID = 'did:imajin:jin-agent';
export const PROPOSAL_ID = 'opap_test123';

/**
 * A byte-for-byte copy of `canonicalize` from `packages/auth/src/sign.ts`
 * (deterministic, sorted-key JSON), duplicated here — rather than
 * imported — so this shared fixture module never depends on how any
 * given test file happens to mock `@imajin/auth` (several do, with
 * different `canonicalize` stand-ins, e.g. `operator-approvals-
 * service.test.ts`'s trivial `JSON.stringify` pass-through vs. the route
 * tests' narrower `{ requireAuth }`-only mock). Test fixtures must produce
 * the same hash everywhere regardless of which mock happens to be active.
 */
function canonicalizeForTestHash(obj: unknown): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (typeof obj === 'boolean' || typeof obj === 'number' || typeof obj === 'string') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalizeForTestHash).join(',')}]`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalizeForTestHash((obj as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(',')}}`;
  }
  return 'null';
}

/**
 * Mirrors `computeApprovalContentHash` in `../operator-approvals` exactly
 * (same fields, same canonicalize + sha256) using the self-contained
 * canonicalize above, rather than importing that module directly — which
 * would pull in its `@/src/lib/kernel/node-identity` import chain (calls
 * `getClient()` at module scope, throws without `DATABASE_URL`) into test
 * files that don't otherwise need or mock it.
 */
function testContentHash(fields: {
  proposalId: string;
  source: string;
  kind: string;
  summary: string;
  keysTouched: string[];
  detail: Record<string, unknown> | null;
}): string {
  return createHash('sha256').update(canonicalizeForTestHash(fields)).digest('hex');
}

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

/**
 * The legacy-shaped pending card (no `source`/`detail` supplied at ingest,
 * so `contentHash` was historically `null`). #2082: `toCard()` now always
 * fills `contentHash` via `effectiveContentHash` so a client always has
 * something to sign against — this fixture computes the same value so
 * assertions built on it stay accurate rather than asserting a stale
 * `null`.
 */
export function pendingApprovalCard(overrides: Record<string, unknown> = {}) {
  const base = {
    proposalId: PROPOSAL_ID,
    operatorDid: OPERATOR_DID,
    source: 'system-agent',
    kind: 'system-agent:restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: [] as string[],
    detail: null,
    status: 'pending' as const,
    decision: null,
    appliedAt: null,
    createdAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    ...overrides,
  };
  const contentHash =
    'contentHash' in overrides
      ? overrides.contentHash
      : testContentHash({
          proposalId: base.proposalId,
          source: base.source,
          kind: base.kind,
          summary: base.summary,
          keysTouched: base.keysTouched,
          detail: base.detail,
        });
  return { ...base, contentHash };
}
