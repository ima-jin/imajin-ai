/**
 * `cycle` loopKind (#2314, child of epic #2313) — registers the sprint
 * cycle (merge-sweep -> raise -> provision -> review -> report) as a
 * first-class loop on the kernel loop registry rail (#2295, PR #2302), the
 * same way #2296's Warp bridge (`apps/kernel/src/lib/warp/loop-emit.ts`)
 * registers each Warp run.
 *
 * ## Mapping onto the existing loop.* rail
 * #2314's own event list (`loop.started`, `loop.phase`, `loop.child`,
 * `loop.completed`/`loop.failed`) is *shape*, not new bus wire types:
 * #2302 already ships exactly four lifecycle kinds
 * (`loop.started|progress|blocked|finished`, `LOOP_LIFECYCLE_TYPES` in
 * `./types.ts`) and `LoopEnvelope` carries an index signature specifically
 * so a `loopKind`-specific payload can ride inside the common envelope
 * without widening the wire protocol (see that module's own doc). This
 * module is deliberately a consumer of that rail only — no new bus kind,
 * no new table, no migration:
 *   - `startCycle`  -> `loop.started`, extra fields `trigger`/`plannedPhases`.
 *   - `cyclePhase`  -> `loop.progress` (or `loop.blocked` when
 *     `status: 'blocked'` — the one phase status with its own dedicated
 *     lifecycle type), `state` = the phase name (so `GET /api/loops
 *     ?state=` and the /jin Runs lane's "live phase" read the current
 *     phase straight off the existing projection column), extra fields
 *     `phase`/`phaseStatus`/`counts`. A `status: 'blocked'` transition sets
 *     `state: 'blocked'` instead, matching `warp.run`'s own
 *     `warpStateToLoopState` convention (`apps/kernel/src/lib/warp/
 *     dispatch.ts`) so a reader can `?state=blocked` uniformly across
 *     loopKinds; which phase it was blocked in still lives in the `phase`
 *     extra field.
 *   - `cycleChild`  -> `loop.progress`, `state: 'child-linked'`, extra
 *     fields `childKind`/`childId` (`refs.runId` too when `childKind` is
 *     `'warp.run'`, so the existing `refs` querying keeps working). The
 *     child's OWN loop entry (`warp.run` already loops itself via #2296)
 *     is never rewritten from here — a `warp.run`'s `parentLoopId` comes
 *     only from Warp's own confirmed orchestration lineage
 *     (`WarpRunLoopTransition.parentRunId`), so the link is recorded as an
 *     event on the CYCLE's own loop stream instead, which is what #2314
 *     asks for ("links Warp runs ... under the cycle").
 *   - `finishCycle` -> `loop.finished`, `state` carries which of the
 *     issue's `loop.completed`/`loop.failed` split applies
 *     (`'completed' | 'failed'`), extra field `cardIds`.
 *
 * ## Signing
 * Same posture as `loop-emit.ts`: the kernel node is the ingest's
 * `publisherDid` (`getNodeSigningIdentity()`); `principal` in the envelope
 * is the human the cycle runs `onBehalfOf` (#2314's own constraint) —
 * never the kernel node, and never the delegate agent DID.
 *
 * ## Idempotency and fail-closed unknown correlationId
 * There is no new table to hold cycle-specific bookkeeping, and this
 * module's calls are expected to span many separate invocations (possibly
 * different server instances) over the lifetime of one cycle, so neither
 * guarantee can rely on in-process state. Both are read back from the
 * EXISTING `kernel.loops` / `kernel.loop_events` rows this module's own
 * prior calls already wrote:
 *   - `cyclePhase`/`cycleChild`/`finishCycle` first resolve `correlationId`
 *     to its registered principal directly against `kernel.loops` (written
 *     by `startCycle`'s own `loop.started`); no row (or a row whose `kind`
 *     is not `cycle`) means the correlationId was never started as a
 *     cycle — fails closed with `{ ok: false, error }`, publishing nothing.
 *   - Having resolved the principal, `getLoopWithHistory` (`./query.ts`,
 *     the same read `GET /api/loops/:loopId` uses) reads the loop's full
 *     event history; a call whose (phase, status, counts) or (childKind,
 *     childId) exactly matches an already-recorded event is a no-op
 *     replay — skipped rather than re-published — so a retried transition
 *     (e.g. an MCP tool call retried after a timeout) never double-counts
 *     on the rail.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { ingestLoopEvent } from './ingest';
import { getLoopWithHistory } from './query';
import type { LoopEnvelope, LoopLifecycleType } from './types';

const log = createLogger('kernel:cycle');

/** `kind` carried by every loop.* event a cycle transition produces (#2314). */
export const CYCLE_LOOP_KIND = 'cycle';

/** Fixed phase names for the sprint cycle (#2313's epic body, #2314's own event doc). */
export const CYCLE_PHASES = ['merge-sweep', 'raise', 'provision', 'review', 'report'] as const;
export type CyclePhaseName = (typeof CYCLE_PHASES)[number];

export function isCyclePhaseName(value: unknown): value is CyclePhaseName {
  return typeof value === 'string' && (CYCLE_PHASES as readonly string[]).includes(value);
}

/** `loop.phase`'s own `status` vocabulary (#2314), plus `blocked` — the one
 * status that maps onto its own dedicated lifecycle type (`loop.blocked`)
 * rather than `loop.progress`. */
export type CyclePhaseStatus = 'started' | 'completed' | 'skipped' | 'blocked';

/** How the cycle was triggered (#2314's `loop.started` event doc). */
export type CycleTrigger = 'chat' | 'mcp' | 'automation';

/** `loop.child`'s own `childKind` vocabulary (#2314's event doc). */
export type CycleChildKind = 'warp.run' | 'subagent' | 'review';

/** Phase-specific counters — shape differs per phase (#2314's event doc), so this
 * stays an open record rather than a fixed interface per phase. */
export type CyclePhaseCounts = Record<string, unknown>;

export type CycleEmitResult = { ok: true } | { ok: false; error: string };

export interface StartCycleInput {
  /** The human this cycle runs onBehalfOf — never the delegate agent DID (#2314's own constraint). */
  principal: string;
  trigger: CycleTrigger;
  plannedPhases: CyclePhaseName[];
}

export type StartCycleResult = { ok: true; correlationId: string } | { ok: false; error: string };

export interface CycleFinishSummary {
  status: 'completed' | 'failed';
  /** Human-readable terminal summary — becomes the envelope's `summary` field. */
  text: string;
  /** Decision-card ids emitted during the cycle (#2314's event doc, sub-issue B / #2315). */
  cardIds?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Sign `payload` as the kernel node witness and ingest it onto the loop
 * rail — mirrors `emitWarpRunLoopEvent`'s witness posture exactly
 * (`getNodeSigningIdentity()`, `canonicalize({ type, payload })`).
 *
 * Unlike `emitWarpRunLoopEvent` (a fire-and-forget bridge off an
 * already-published `warp.run.*` event), this module IS the primary
 * publish path for cycle transitions, so failures are reported back to
 * the caller rather than only logged — an MCP tool or skill driving the
 * cycle needs to know whether a phase transition actually landed.
 */
async function signAndIngest(type: LoopLifecycleType, payload: LoopEnvelope): Promise<CycleEmitResult> {
  try {
    const identity = getNodeSigningIdentity();
    const signature = {
      keyId: identity.senderPubkey.toLowerCase(),
      alg: 'ed25519' as const,
      sig: authCrypto
        .signSync(canonicalize({ type, payload }), identity.privateKeyHex)
        .toLowerCase(),
    };

    const result = await ingestLoopEvent({
      type,
      payload,
      publisherDid: identity.senderDid,
      signature,
    });

    if (!result.ok) {
      log.warn({ type, loopId: payload.loopId, reason: result.error }, 'cycle loop emission rejected at ingest');
      return { ok: false, error: result.error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err: error, type, loopId: payload.loopId }, 'cycle loop emission failed');
    return { ok: false, error };
  }
}

/**
 * Internal-only lookup: resolve a cycle loopId's registered principal
 * directly against `kernel.loops`, bypassing the principal-scoped WHERE
 * clause every externally-authenticated read (`./query.ts`) applies — safe
 * here because this only ever runs against a loopId this same module
 * minted via `startCycle`, never one taken from an untrusted request.
 * Scoped to `kind = 'cycle'` so a loopId belonging to some other loopKind
 * (e.g. a `warp.run`) is never mistaken for a cycle.
 */
async function resolveCyclePrincipal(loopId: string): Promise<string | null> {
  const sql = getClient();
  const rows = (await sql`
    SELECT principal FROM kernel.loops WHERE loop_id = ${loopId} AND kind = ${CYCLE_LOOP_KIND} LIMIT 1
  `) as unknown as Array<{ principal: string }>;
  return rows[0]?.principal ?? null;
}

interface ResolvedCycle {
  principal: string;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

type ResolveCycleResult = { ok: true; value: ResolvedCycle } | { ok: false; error: string };

function unknownCorrelationId(correlationId: string): ResolveCycleResult {
  return { ok: false, error: `unknown correlationId (no cycle loop registered): ${correlationId}` };
}

/** Shared fail-closed + idempotency-data lookup for every call except `startCycle`. */
async function resolveCycle(correlationId: string): Promise<ResolveCycleResult> {
  const principal = await resolveCyclePrincipal(correlationId);
  if (!principal) {
    return unknownCorrelationId(correlationId);
  }

  const history = await getLoopWithHistory(correlationId, principal);
  if (!history) {
    // Can't happen in practice (resolveCyclePrincipal just found the row), but
    // fail closed rather than assume — same posture as an unknown correlationId.
    return unknownCorrelationId(correlationId);
  }

  return { ok: true, value: { principal, events: history.events } };
}

function countsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * Start a new cycle loop: `{ principal, trigger, plannedPhases }` ->
 * `loop.started`, `loopId` generated fresh per call (one `correlationId`
 * per cycle, #2314's own acceptance).
 */
export async function startCycle(input: StartCycleInput): Promise<StartCycleResult> {
  const correlationId = `cycle_${randomUUID()}`;
  const payload: LoopEnvelope = {
    loopId: correlationId,
    kind: CYCLE_LOOP_KIND,
    principal: input.principal,
    parentLoopId: null,
    state: 'started',
    summary: `cycle started (${input.trigger})`,
    at: nowIso(),
    trigger: input.trigger,
    plannedPhases: input.plannedPhases,
  };

  const result = await signAndIngest('loop.started', payload);
  if (!result.ok) return result;
  return { ok: true, correlationId };
}

/**
 * Record a phase transition: `loop.progress` (or `loop.blocked` when
 * `status === 'blocked'`). Idempotent — replaying the exact same
 * `(phase, status, counts)` for a `correlationId` that already has a
 * matching event on the rail is a no-op.
 */
export async function cyclePhase(
  correlationId: string,
  phase: CyclePhaseName,
  status: CyclePhaseStatus,
  counts: CyclePhaseCounts = {},
): Promise<CycleEmitResult> {
  const resolved = await resolveCycle(correlationId);
  if (!resolved.ok) return resolved;
  const { principal, events } = resolved.value;

  const type: LoopLifecycleType = status === 'blocked' ? 'loop.blocked' : 'loop.progress';

  const alreadyEmitted = events.some((event) => {
    if (event.type !== type) return false;
    const p = event.payload;
    return p.phase === phase && p.phaseStatus === status && countsEqual(p.counts, counts);
  });
  if (alreadyEmitted) {
    log.info({ correlationId, phase, phaseStatus: status }, 'cycle phase transition already recorded; skipping duplicate emission');
    return { ok: true };
  }

  const payload: LoopEnvelope = {
    loopId: correlationId,
    kind: CYCLE_LOOP_KIND,
    principal,
    state: status === 'blocked' ? 'blocked' : phase,
    summary: `cycle phase ${phase} ${status}`,
    at: nowIso(),
    phase,
    phaseStatus: status,
    counts,
  };

  return signAndIngest(type, payload);
}

/**
 * Link a child (a Warp run, a review sub-agent, or another subagent) under
 * the cycle: `loop.progress`, `state: 'child-linked'`. Idempotent — linking
 * the same `(childKind, childId)` twice for a `correlationId` is a no-op.
 */
export async function cycleChild(
  correlationId: string,
  childKind: CycleChildKind,
  childId: string,
): Promise<CycleEmitResult> {
  const resolved = await resolveCycle(correlationId);
  if (!resolved.ok) return resolved;
  const { principal, events } = resolved.value;

  const alreadyLinked = events.some((event) => {
    if (event.type !== 'loop.progress') return false;
    const p = event.payload;
    return p.state === 'child-linked' && p.childKind === childKind && p.childId === childId;
  });
  if (alreadyLinked) {
    log.info({ correlationId, childKind, childId }, 'cycle child already linked; skipping duplicate emission');
    return { ok: true };
  }

  const payload: LoopEnvelope = {
    loopId: correlationId,
    kind: CYCLE_LOOP_KIND,
    principal,
    state: 'child-linked',
    summary: `linked ${childKind} ${childId}`,
    at: nowIso(),
    childKind,
    childId,
    ...(childKind === 'warp.run' ? { refs: { runId: childId } } : {}),
  };

  return signAndIngest('loop.progress', payload);
}

/**
 * Finish a cycle: `loop.finished`, `state` = `summary.status`
 * (`'completed' | 'failed'`, the issue's terminal split). Idempotent — a
 * cycle that already has a `loop.finished` event is left alone.
 */
export async function finishCycle(correlationId: string, summary: CycleFinishSummary): Promise<CycleEmitResult> {
  const resolved = await resolveCycle(correlationId);
  if (!resolved.ok) return resolved;
  const { principal, events } = resolved.value;

  const alreadyFinished = events.some((event) => event.type === 'loop.finished');
  if (alreadyFinished) {
    log.info({ correlationId }, 'cycle already finished; skipping duplicate emission');
    return { ok: true };
  }

  const payload: LoopEnvelope = {
    loopId: correlationId,
    kind: CYCLE_LOOP_KIND,
    principal,
    state: summary.status,
    summary: summary.text,
    at: nowIso(),
    cardIds: summary.cardIds ?? [],
  };

  return signAndIngest('loop.finished', payload);
}
