/**
 * Publisher authorization for `agent.turn.evidence` (#1978).
 *
 * A valid agent signature only proves the agent controls its own DID key —
 * it says nothing about whether that agent may write evidence *about a
 * principal's turn*. Same shape as `authorizeLoopPublisher`
 * (`../loops/authorize-publisher.ts`, #2358), minus the node-witness path
 * (the kernel node never witnesses agent turns):
 *
 *   1. Self-attestation: `agentDid === principalDid`.
 *   2. Otherwise an active, unexpired `delegationGrants` (#1882) row where
 *      `agentDid` is the agent, `principalDid` is the delegator, and the
 *      grant holds `evidence:publish` (`packages/auth/src/grant-scopes.ts`).
 *      Reuses `introspectGrant` — re-reads storage on every call, so a
 *      revoked/expired grant denies on the very next batch.
 *
 * Fails closed: a storage error from `introspectGrant` propagates as a
 * rejected promise rather than resolving authorized.
 *
 * This codes against the *existing* DID types only. The `actor/agent` DID
 * subtype and its `serviceOf` relation (#2407) are a separate in-flight
 * change; once it lands, `serviceOf` could become a further accepted path
 * here — deliberately not implemented in this issue.
 */
import { introspectGrant } from '@/src/lib/auth/grants';
import type { AuthorizeResult } from './ingest';

/** The delegation-grant capability that authorizes `agentDid` to publish turn evidence for `delegatorDid`. */
export const EVIDENCE_PUBLISH_CAPABILITY = 'evidence:publish';

export async function authorizeEvidencePublisher(agentDid: string, principalDid: string): Promise<AuthorizeResult> {
  if (agentDid === principalDid) {
    return { authorized: true, grantId: null };
  }

  const introspection = await introspectGrant({
    agentDid,
    capability: EVIDENCE_PUBLISH_CAPABILITY,
    delegatorDid: principalDid,
    targetDid: principalDid,
  });

  if (!introspection.authorized) {
    return { authorized: false };
  }
  return { authorized: true, grantId: introspection.grantId ?? null };
}
