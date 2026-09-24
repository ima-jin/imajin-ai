/**
 * warp.run.* -> loop.* lifecycle bridge (#2296, child of epic #2288/#2290).
 *
 * Bridges each of `dispatch.ts`'s existing `warp.run.*`/`warp.agent.dispatched`
 * publish points onto the kernel loop registry rail (#2295, PR #2302)
 * additively: every dispatched, resumed, progressed, blocked, completed,
 * failed, or timed-out Warp run transition also gets a `kind: 'warp.run'`
 * `loop.*` event, `loopId = runId` — see `WarpRunLoopTransition`.
 *
 * ## Signing
 * Signed the same way `operator.approval.decided` is witnessed
 * (`getNodeSigningIdentity()`, `apps/kernel/src/lib/vault/sealing.ts`): the
 * kernel node signs and is the ingest's `publisherDid`, while `principal`
 * inside the envelope stays the dispatching DID (onBehalfOf) — the loop's
 * own scope/authz boundary (`GET /api/loops`). Ingested via the same
 * `ingestLoopEvent` (`apps/kernel/src/lib/loops/ingest.ts`) `POST /api/loops`
 * itself calls, so this reuses the one signature-verification + publish +
 * projection path rather than re-implementing any piece of the rail.
 *
 * ## Why this lives in its own module
 * `dispatch.ts` documents itself as holding no DB dependency of its own (see
 * its module doc, "Duplicate-publish race guard" — `claimTerminalPublish` is
 * injected rather than imported for the same reason). This module is where
 * the loop rail's DB dependency (`ingestLoopEvent` → DB-backed publisher-key
 * resolution, `getNodeSigningIdentity()` → vault key derivation) actually
 * lives; `dispatch.ts` reaches it only through a dynamic `import()` at the
 * point of use (mirroring `packages/bus/src/config.ts`'s own "dynamic import
 * to avoid pulling in the DB connection at module load time" pattern), so
 * `dispatch.ts`'s own unit tests — which never touch a real DB — are
 * unaffected: a dynamic import that fails (e.g. no `DATABASE_URL` in a test
 * process) is caught and logged, never thrown.
 *
 * ## Idempotency
 * Idempotency comes for free from the SAME guard that already protects each
 * corresponding `warp.run.*` publish from firing twice (#2295's own design
 * note): `publishRunCompleted`/`publishRunFailed` only run once
 * `claimTerminalPublish` (#2043) has been won, `publishRunBlocked` only runs
 * once per watch/sweep via `blockedNotified`/`hasPublishedBlockedNotice`, and
 * `publishRunProgress` only runs when something actually changed. No new
 * idempotency mechanism is needed here — replaying an already-deduplicated
 * transition never reaches this module a second time.
 */
import { createLogger } from '@imajin/logger';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { ingestLoopEvent } from '@/src/lib/loops/ingest';
import type { LoopEnvelope, LoopLifecycleType } from '@/src/lib/loops/types';

const log = createLogger('kernel:warp-loop-emit');

/** `loopKind` carried by every loop.* event a Warp run transition produces (#2296). */
const WARP_RUN_LOOP_KIND = 'warp.run';

/**
 * One warp.run.* transition, reduced to what the common `loop.*` envelope
 * needs. `runId` doubles as the loop id (#2296's acceptance: "the run id as
 * the loop id") and `principalDid` is the run's own dispatching DID —
 * onBehalfOf — never the kernel node that signs the envelope.
 */
export interface WarpRunLoopTransition {
  type: LoopLifecycleType;
  runId: string;
  principalDid: string;
  /** Warp-confirmed orchestration lineage (#1939), or null when unknown/absent. */
  parentRunId: string | null;
  /** Publisher-defined state label, e.g. 'queued' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'. */
  state: string;
  summary: string;
  /** ISO 8601 — should match the timestamp already used on the sibling `warp.run.*` event. */
  at: string;
}

/**
 * Sign `transition` as the kernel node witness and ingest it onto the loop
 * rail (#2295). Mirrors `operator.approval.decided`'s witness posture
 * (`getNodeSigningIdentity()`) — the node is the ingest's `publisherDid`,
 * never the dispatching DID, which stays the envelope's `principal`.
 *
 * Never throws: a failed loop emission must not cost the `warp.run.*`
 * publish that already happened, the same invariant every publish in
 * `dispatch.ts` follows for its own bus publish.
 */
export async function emitWarpRunLoopEvent(transition: WarpRunLoopTransition): Promise<void> {
  try {
    const payload: LoopEnvelope = {
      loopId: transition.runId,
      kind: WARP_RUN_LOOP_KIND,
      principal: transition.principalDid,
      parentLoopId: transition.parentRunId,
      refs: { runId: transition.runId },
      state: transition.state,
      summary: transition.summary,
      at: transition.at,
    };

    const identity = getNodeSigningIdentity();
    const signature = {
      keyId: identity.senderPubkey.toLowerCase(),
      alg: 'ed25519' as const,
      sig: authCrypto
        .signSync(canonicalize({ type: transition.type, payload }), identity.privateKeyHex)
        .toLowerCase(),
    };

    const result = await ingestLoopEvent({
      type: transition.type,
      payload,
      publisherDid: identity.senderDid,
      signature,
    });

    if (!result.ok) {
      log.warn(
        { type: transition.type, runId: transition.runId, reason: result.error },
        'warp.run -> loop.* emission rejected at ingest',
      );
    }
  } catch (err) {
    log.error(
      { err: String(err), type: transition.type, runId: transition.runId },
      'warp.run -> loop.* emission failed',
    );
  }
}
