/**
 * MCP cycle-trigger tools (#2316).
 *
 * `cycle_run` / `cycle_status` are the one-statement trigger for the sprint
 * cycle: "run the cycle" / "how's the cycle going" without an orchestrating
 * agent having to know the loop-registry wire shape. A cycle IS a loop
 * (#2297/#2295's `loops_list`/`loops_get` read-model pattern) of
 * `kind: 'cycle'` (#2314, `../../loops/cycle.ts`) — this file adds no new
 * rail, no new table, no migration; it is a thin MCP surface over that
 * already-shipped module plus the already-shipped DecisionCard emitter
 * (#2315, `../../decisions/emit.ts`).
 *
 * ## Scope of #2316 (read this before touching phase logic)
 * #2316 is ONLY the MCP tool surface — cycle_run/cycle_status — that will
 * eventually trigger/read the real Phase 1-5 cycle orchestration engine
 * (merge-sweep, hot-issue-raise, brief+provision, review-rounds, report).
 * That engine does not exist yet as a callable unit, so `runCyclePhaseStub`
 * below is a deliberate, clearly-marked seam: it registers the cycle's
 * intent on the loop rail (and, in dry-run, previews it as a DecisionCard)
 * but performs no merge, no file, no dispatch. Building that engine is
 * explicitly out of scope here — see the seam's own doc comment.
 *
 * ## No hidden actions (#2316 constraint)
 * "Everything the cycle does is a rail event or a card. If a phase can't
 * produce one of those, it doesn't run." Since the phase engine is stubbed,
 * no phase can yet merge/file/dispatch anything — so every requested phase
 * is recorded as a `skipped` transition on the cycle's own loop rail
 * (`cyclePhase(..., 'skipped', ...)`, never silently dropped), and a
 * dry-run additionally raises a DecisionCard previewing what the phase
 * would do once the engine is wired up.
 *
 * ## Authority never widens here (#2316 constraint)
 * "Authority evaluation is per-action and lives in the card — the tool
 * never widens what the caller may do." `cycle:run` (below) only lets a
 * caller register and read their OWN cycle loop and raise a DecisionCard
 * about it — it grants no merge/file/dispatch authority. When the phase
 * engine is eventually built, each concrete action it takes (e.g. a
 * `github:write` merge, a `warp:dispatch` provision) is checked against
 * that action's OWN scope at the time it runs, exactly like every other
 * MCP write tool in this directory (`tools/warp.ts`, `tools/github.ts`) —
 * this tool is not where that check lives.
 *
 * ## Per-principal, sealed key stamping (#1428/#1639 pattern)
 * Every call here is scoped to `ctx.did` — the resource-owner DID resolved
 * by the /mcp route — never a tool argument, same posture every other MCP
 * tool in this directory follows (see tools/loops.ts, tools/warp.ts).
 * `startCycle` stamps the cycle's `principal` with `ctx.did`: the acting
 * human's own delegation, never the delegate agent's own DID (#2314's own
 * constraint, carried through unchanged from `../../loops/cycle.ts`). When
 * the phase engine is built and needs to dispatch a Warp cloud agent, it
 * must dispatch under THAT principal's own sealed Warp Agent key
 * (`../../warp/dispatch.ts`'s `dispatchAgentRun(ctx.did, ...)` pattern) —
 * never the agent's own credential — exactly as #1428/#1639 established for
 * `warp_dispatch_agent`. Nothing here spends that key yet (the stub takes
 * no action), but the seam is written so wiring it in later cannot
 * accidentally reach for the wrong identity.
 *
 * Template: modelled on tools/loops.ts (per-principal loop reads) and
 * tools/warp.ts (one scope gating both the write tool and its own read
 * tools). RFC-32 federated-growth contract: only this file + tools/index.ts
 * change.
 */
import type { McpTool } from '../types';
import { str, json } from './utils';
import { requireMcpGrant } from '../mcp-grant';
import {
  startCycle,
  cyclePhase,
  finishCycle,
  CYCLE_PHASES,
  CYCLE_LOOP_KIND,
  isCyclePhaseName,
  type CyclePhaseName,
} from '../../loops/cycle';
import { getLoopWithHistory, listLoopsPage } from '../../loops/query';
import type { LoopEventJson } from '../../loops/serialize';
import { getOperatorDid } from '../../notify/operator-approvals';
import { listApprovalsForOperator } from '../../notify/operator-approvals-service';
import { emitDecisionCard, DECISION_APPROVAL_SOURCE } from '../../decisions/emit';

const CYCLE_SCOPE = 'cycle:run';

// ── Argument parsing ─────────────────────────────────────────────────────────

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * `phases` — a subset of the fixed sprint-cycle vocabulary, or all five when
 * omitted (#2316's own default). Always returned in the fixed `CYCLE_PHASES`
 * order regardless of the order the caller listed them in, so phase
 * execution is always merge-sweep -> raise -> provision -> review -> report.
 */
function parsePhasesArg(args: Record<string, unknown>): ParseResult<CyclePhaseName[]> {
  const raw = args.phases;
  if (raw === undefined) return { ok: true, value: [...CYCLE_PHASES] };
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'phases must be a non-empty array of phase names' };
  }

  const requested = new Set<CyclePhaseName>();
  for (const entry of raw) {
    if (!isCyclePhaseName(entry)) {
      return {
        ok: false,
        error: `phases contains an unknown phase name: ${JSON.stringify(entry)} (expected one of ${CYCLE_PHASES.join(', ')})`,
      };
    }
    requested.add(entry);
  }

  return { ok: true, value: CYCLE_PHASES.filter((phase) => requested.has(phase)) };
}

export interface CycleRunScope {
  repo: string;
  labels?: string[];
  issues?: number[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

/** `scope` — optional; when present, `repo` is required (`labels`/`issues` narrow it further). */
function parseScopeArg(args: Record<string, unknown>): ParseResult<CycleRunScope | undefined> {
  const raw = args.scope;
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'scope must be an object' };
  }

  const body = raw as Record<string, unknown>;
  const repo = str(body, 'repo');
  if (repo === undefined) return { ok: false, error: 'scope.repo is required when scope is set' };

  if (body.labels !== undefined && !isStringArray(body.labels)) {
    return { ok: false, error: 'scope.labels must be an array of strings' };
  }
  if (body.issues !== undefined && !isNumberArray(body.issues)) {
    return { ok: false, error: 'scope.issues must be an array of numbers' };
  }

  const labels = body.labels as string[] | undefined;
  const issues = body.issues as number[] | undefined;

  return {
    ok: true,
    value: {
      repo,
      ...(labels === undefined ? {} : { labels }),
      ...(issues === undefined ? {} : { issues }),
    },
  };
}

// ── Phase-runner seam (TODO: out of scope for #2316 — see file doc) ─────────

/** Fixed reason recorded on every stub phase transition, so a `loops_get`/`cycle_status` reader — human or agent — sees WHY nothing happened rather than guessing at a silent skip. */
const PHASE_RUNNER_NOT_IMPLEMENTED =
  'phase runner not implemented yet — #2316 shipped only the cycle_run/cycle_status MCP tool surface; ' +
  'wiring merge-sweep/hot-issue-raise/brief+provision/review-rounds/report is tracked as follow-up work';

/**
 * TODO(follow-up to #2316): replace this stub with the real phase engine.
 *
 * This is the ONE seam a future phase-runner PR should replace: it is
 * called once per requested phase, in fixed `CYCLE_PHASES` order, and owns
 * deciding what that phase does. Today it does nothing but honestly say so:
 *   - `dryRun`: raises a DecisionCard (#2315) previewing that this phase
 *     would run once the engine exists, tagged with this cycle's own
 *     `correlationId` so `cycle_status` surfaces it under `openCardIds`.
 *   - always: records `cyclePhase(correlationId, phase, 'skipped', ...)` on
 *     the cycle's own loop rail — the "no hidden actions" constraint means
 *     a phase that cannot act must still leave a rail event, never a silent
 *     no-op.
 *
 * Deliberately takes no scope-shaped action (no GitHub call, no Warp
 * dispatch): building that is explicitly out of scope for #2316 per the
 * issue's own "out of scope" list.
 */
async function runCyclePhaseStub(
  correlationId: string,
  phase: CyclePhaseName,
  scope: CycleRunScope | undefined,
  dryRun: boolean,
): Promise<{ cardId: string | null }> {
  let cardId: string | null = null;

  if (dryRun) {
    const emitted = await emitDecisionCard({
      correlationId,
      source: 'automation',
      subject: { kind: 'run', ref: correlationId, url: `/api/loops/${correlationId}` },
      question: `Cycle phase '${phase}' would run here (dry run) — no phase runner is wired up yet`,
      options: [
        {
          letter: 'a',
          label: 'Acknowledge preview',
          consequence: 'No action is taken; this phase still needs a real runner before it can merge/file/dispatch anything.',
        },
        {
          letter: 'b',
          label: 'File follow-up work',
          consequence: 'Track wiring this phase up as its own tracked issue.',
        },
      ],
      rec: { letter: 'a', why: 'Nothing can be enacted until the phase runner exists (#2316 shipped the MCP tool surface only).' },
      evidence: {
        authority: {
          canActWithoutHuman: false,
          rule: 'phase-runner stub — always requires a human decision until a real engine is wired up (#2316)',
        },
      },
    });
    if (emitted.ok) cardId = emitted.proposalId;
  }

  await cyclePhase(correlationId, phase, 'skipped', {
    dryRun,
    ...(scope === undefined ? {} : { scope }),
    ...(cardId === null ? {} : { cardId }),
    reason: PHASE_RUNNER_NOT_IMPLEMENTED,
  });

  return { cardId };
}

// ── cycle_run ─────────────────────────────────────────────────────────────

const cycleRunTool: McpTool = {
  name: 'cycle_run',
  requiredScope: CYCLE_SCOPE,
  description:
    'Start your sprint cycle: registers a cycle loop on your own behalf and walks its five fixed phases ' +
    '(merge-sweep, hot-issue-raise, brief+provision, review-rounds, report — default: all five). ' +
    'Returns { correlationId }; read progress with cycle_status. dry_run (default false) previews each ' +
    'phase as a DecisionCard instead of enacting it. The underlying phase engine is not wired up yet ' +
    '(#2316 shipped the MCP tool surface only), so every phase is currently recorded as skipped on the ' +
    "cycle's own rail — nothing merges, files, or dispatches until that follow-up lands. Requires an " +
    'active cycle:run grant on the Imajin MCP connector.',
  inputSchema: {
    type: 'object',
    properties: {
      phases: {
        type: 'array',
        items: { type: 'string', enum: [...CYCLE_PHASES] },
        description: 'Optional subset of phases to run, in any order (always executed in the fixed cycle order). Defaults to all five.',
      },
      scope: {
        type: 'object',
        description: 'Optional scope narrowing which repo (and which labels/issues within it) this cycle acts on.',
        properties: {
          repo: { type: 'string', description: "Required when scope is set, e.g. 'ima-jin/imajin-ai'." },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional label filter.' },
          issues: { type: 'array', items: { type: 'number' }, description: 'Optional explicit issue-number filter.' },
        },
        required: ['repo'],
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview each phase as a DecisionCard instead of enacting it. Defaults to false.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, CYCLE_SCOPE, ctx.appDid);

    const phasesResult = parsePhasesArg(args);
    if (!phasesResult.ok) throw new Error(phasesResult.error);

    const scopeResult = parseScopeArg(args);
    if (!scopeResult.ok) throw new Error(scopeResult.error);

    const dryRun = args.dry_run === true;
    const plannedPhases = phasesResult.value;

    const started = await startCycle({ principal: ctx.did, trigger: 'mcp', plannedPhases });
    if (!started.ok) throw new Error(`cycle_run failed to start: ${started.error}`);
    const { correlationId } = started;

    const cardIds: string[] = [];
    for (const phase of plannedPhases) {
      const { cardId } = await runCyclePhaseStub(correlationId, phase, scopeResult.value, dryRun);
      if (cardId !== null) cardIds.push(cardId);
    }

    await finishCycle(correlationId, {
      status: 'completed',
      text: dryRun
        ? `dry run: previewed ${plannedPhases.length} phase(s) — phase runner not implemented yet`
        : `${plannedPhases.length} phase(s) skipped — phase runner not implemented yet`,
      cardIds,
    });

    return json({ correlationId });
  },
};

// ── cycle_status ──────────────────────────────────────────────────────────

interface CycleChildRef {
  childKind: string;
  childId: string;
}

/** Per-phase status, keyed by phase name, folding `loop.progress`/`loop.blocked` events in occurred-at order so a later transition overwrites an earlier one. */
function derivePhaseStatuses(events: LoopEventJson[]): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const event of events) {
    if (event.type !== 'loop.progress' && event.type !== 'loop.blocked') continue;
    const { phase, phaseStatus } = event.payload;
    if (typeof phase === 'string' && typeof phaseStatus === 'string') {
      statuses[phase] = phaseStatus;
    }
  }
  return statuses;
}

/** Every `cycleChild`-linked child (Warp run, sub-agent, review), in the order they were linked. */
function deriveChildren(events: LoopEventJson[]): CycleChildRef[] {
  const children: CycleChildRef[] = [];
  for (const event of events) {
    if (event.type !== 'loop.progress' || event.payload.state !== 'child-linked') continue;
    const { childKind, childId } = event.payload;
    if (typeof childKind === 'string' && typeof childId === 'string') {
      children.push({ childKind, childId });
    }
  }
  return children;
}

/** Every still-`pending` DecisionCard proposalId raised against this cycle's own correlationId. */
async function openCardIdsForCycle(correlationId: string): Promise<string[]> {
  const operatorDid = await getOperatorDid();
  if (!operatorDid) return [];

  const approvals = await listApprovalsForOperator(operatorDid, { source: DECISION_APPROVAL_SOURCE });
  const openIds: string[] = [];
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;
    const detail = approval.detail as { correlationId?: unknown } | null;
    if (detail?.correlationId === correlationId) openIds.push(approval.proposalId);
  }
  return openIds;
}

/** The caller's own most-recently-active cycle loopId, or undefined when they have none yet. */
async function mostRecentCycleId(principal: string): Promise<string | undefined> {
  const page = await listLoopsPage({ principal, kind: CYCLE_LOOP_KIND, limit: 1 });
  return page.loops[0]?.loopId;
}

const cycleStatusTool: McpTool = {
  name: 'cycle_status',
  requiredScope: CYCLE_SCOPE,
  description:
    'Read your sprint cycle: current phase, per-phase status, linked children (Warp runs, reviews), and ' +
    'open DecisionCard ids. Omit correlation_id to read your own most recently active cycle. Only resolves ' +
    'cycles you started — a correlation_id belonging to a different principal, or naming a non-cycle loop, ' +
    'is reported as not-found. Requires an active cycle:run grant on the Imajin MCP connector.',
  inputSchema: {
    type: 'object',
    properties: {
      correlation_id: {
        type: 'string',
        description: 'The correlationId returned by cycle_run. Omit to read your own most recently active cycle.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, CYCLE_SCOPE, ctx.appDid);

    const correlationId = str(args, 'correlation_id') ?? (await mostRecentCycleId(ctx.did));
    if (correlationId === undefined) {
      throw new Error('not_found: you have no cycles yet — call cycle_run first');
    }

    const history = await getLoopWithHistory(correlationId, ctx.did);
    if (!history || history.loop.kind !== CYCLE_LOOP_KIND) {
      throw new Error('not_found: no cycle with that correlationId is visible to you');
    }

    const openCardIds = await openCardIdsForCycle(correlationId);

    return json({
      correlationId,
      state: history.loop.state,
      summary: history.loop.summary,
      startedAt: history.loop.startedAt,
      finishedAt: history.loop.finishedAt,
      phases: derivePhaseStatuses(history.events),
      children: deriveChildren(history.events),
      openCardIds,
    });
  },
};

export const cycleTools: McpTool[] = [cycleRunTool, cycleStatusTool];
