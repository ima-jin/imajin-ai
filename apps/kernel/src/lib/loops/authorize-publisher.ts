/**
 * Publisher-authorization gate for the kernel loop registry (#2358).
 *
 * `verifyLoopPublisherSignature` (./verify-publisher-signature.ts) only
 * proves the publisher controls the DID it claims — signing a message with
 * `publisherDid`'s key says nothing about whether that publisher is allowed
 * to write loop history *for* `payload.principal`. Before #2358 any signed
 * DID could assert `loop.*` lifecycle events for any principal, which
 * would let a forged/compromised-but-otherwise-valid DID inject fabricated
 * history right as #2296/#2297 and the `/jin` Runs lane start trusting the
 * rail. This module is the second, independent check `ingestLoopEvent`
 * runs before publishing:
 *
 *   1. Self-attestation: `publisherDid === principal` — a DID always may
 *      publish its own loop history.
 *   2. The kernel node's own signing-DID path (#2338): `getNodeSigningIdentity()`
 *      witnesses every `warp.run.*` (`../warp/loop-emit.ts`) and `cycle`
 *      (`./cycle.ts`) transition on behalf of whichever human dispatched
 *      or triggered it — `principal` is that dispatching DID, never the
 *      node's own DID, so neither self-attestation nor a realistic
 *      per-principal delegation grant could ever cover it. #2338 already
 *      established that the node's own signing DID is deliberately never
 *      registered (a registry write the node's own verification path
 *      "shouldn't depend on... succeeding") and is instead resolved
 *      in-process for signature verification; the same reasoning applies
 *      here — the node isn't an external actor crossing this ingest
 *      boundary, it's the same trusted process enforcing the boundary, so
 *      its own witnessed events are exempt from the delegation-grant check
 *      exactly the way they're exempt from registry-based key resolution.
 *   3. Otherwise: an active, unexpired `delegationGrants` (#1882) row where
 *      `publisherDid` is the `agentDid`, `principal` is the `delegatorDid`,
 *      and the grant holds the `loops:publish` capability
 *      (`packages/auth/src/grant-scopes.ts`). Reuses `introspectGrant` —
 *      the same fail-closed, re-read-on-every-call primitive every other
 *      cross-DID capability in this codebase checks (e.g. `agent:reach`,
 *      `usage:read`) — so a revoked or expired grant denies on the very
 *      next call, with no caching to go stale.
 *
 * Anything else is rejected. Fails closed: a storage error from
 * `introspectGrant` propagates as a rejected promise rather than resolving
 * `authorized: true` — same posture as every other `introspectGrant` call
 * site.
 */
import { introspectGrant } from '@/src/lib/auth/grants';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

/** #2358: the delegation-grant capability that authorizes `agentDid` to publish `loop.*` history for `delegatorDid` (packages/auth/src/grant-scopes.ts). */
export const LOOP_PUBLISH_CAPABILITY = 'loops:publish';

export type AuthorizeLoopPublisherResult = { authorized: true } | { authorized: false; reason: string };

/**
 * May `publisherDid` publish `loop.*` history naming `principal`? See the
 * module doc above for the three accepted paths. Never resolves
 * `authorized: true` for anything else — only a genuine storage failure
 * inside `introspectGrant` propagates (rejected promise), and the caller
 * (`ingestLoopEvent`) is responsible for never treating that as an allow.
 */
export async function authorizeLoopPublisher(publisherDid: string, principal: string): Promise<AuthorizeLoopPublisherResult> {
  if (publisherDid === principal) {
    return { authorized: true };
  }

  if (publisherDid === getNodeSigningIdentity().senderDid) {
    return { authorized: true };
  }

  const introspection = await introspectGrant({
    agentDid: publisherDid,
    capability: LOOP_PUBLISH_CAPABILITY,
    delegatorDid: principal,
    targetDid: principal,
  });

  if (!introspection.authorized) {
    return { authorized: false, reason: 'publisherDid is not authorized to publish loop history for principal' };
  }

  return { authorized: true };
}
