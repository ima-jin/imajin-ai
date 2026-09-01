/**
 * Layer 2 `before_agent_finalize` wiring (issue #1252). This hook can only
 * ask the harness for `{ action: "revise", reason, retry? }` (one more model
 * pass) or `{ action: "finalize" }` — confirmed against
 * `docs/plugins/hooks.md` and `AgentHarnessBeforeAgentFinalizeOutcome` in
 * openclaw/openclaw. It cannot cancel or rewrite outbound content directly,
 * which is why the hard Layer 1 guard lives on `message_sending`/
 * `before_dispatch` instead (see `src/outbound-guard-hooks.ts`).
 *
 * Ships wired but INERT by default: `reflex.enabled` must be explicitly
 * `true` (issue scope: "Wire it to before_agent_finalize behind a config
 * flag, default OFF").
 */
import type { InjectionChecker, ReflexTurnContext, WarrantGate } from "./reflex-types.js";
import { createHeuristicWarrantGate } from "./reflex-warrant-gate.js";
import { createStubInjectionChecker } from "./reflex-injection-check.js";
import { buildBetaStamp } from "./reflex-stamp.js";
import { createReflexLogger, DEFAULT_REFLEX_LOG_PATH, type ReflexLogger } from "./reflex-log.js";

/** `plugins.entries.reflex-guard.config.reflex` (openclaw.json). */
export interface ReflexConfig {
  /** Explicit opt-in. Defaults to false — Layer 2 ships as a scaffold, not a live guard. */
  enabled?: boolean;
  /** JSONL path for reflex-log records. */
  logPath?: string;
}

/**
 * `before_agent_finalize` event. `finalAnswer` is this module's own field
 * name for "the natural final answer" the hook inspects (docs/plugins/hooks.md);
 * `text` is accepted as a defensive alias in case a runtime surfaces it under
 * a different key.
 */
export interface BeforeAgentFinalizeEvent {
  finalAnswer?: string;
  text?: string;
  sessionKey?: string;
  runId?: string;
  [key: string]: unknown;
}

/** `PluginHookBeforeAgentFinalizeResult` (openclaw/openclaw `src/plugins/hook-types.ts`). */
export interface BeforeAgentFinalizeResult {
  action: "revise" | "finalize";
  reason?: string;
  retry?: { instruction: string; maxAttempts?: number; idempotencyKey?: string };
}

export interface ReflexFinalizeHookOptions {
  warrantGate?: WarrantGate;
  injectionChecker?: InjectionChecker;
  logger?: ReflexLogger;
}

export interface ReflexPipelineResult {
  warranted: boolean;
  triggers: ReturnType<WarrantGate["evaluate"]>["triggers"];
  findings: Awaited<ReturnType<InjectionChecker["checkConcerns"]>>;
  trippedFindings: Awaited<ReturnType<InjectionChecker["checkConcerns"]>>;
  stamp?: string;
}

function extractFinalAnswer(event: BeforeAgentFinalizeEvent): string {
  if (typeof event?.finalAnswer === "string") return event.finalAnswer;
  if (typeof event?.text === "string") return event.text;
  return "";
}

/**
 * Runs the full warrant-gate -> injection-check -> own-and-stamp pipeline for
 * one turn. Exported standalone (not just as the hook handler closure) so it
 * is directly unit-testable without a fake hook event.
 */
export async function evaluateReflexTurn(
  turn: ReflexTurnContext,
  warrantGate: WarrantGate,
  injectionChecker: InjectionChecker,
): Promise<ReflexPipelineResult> {
  const gateResult = warrantGate.evaluate(turn);
  if (!gateResult.warranted) {
    return { warranted: false, triggers: gateResult.triggers, findings: [], trippedFindings: [], stamp: undefined };
  }
  const findings = await injectionChecker.checkConcerns(turn, gateResult.triggers);
  const trippedFindings = findings.filter((finding) => finding.tripped);
  const stamp = buildBetaStamp(findings);
  return { warranted: true, triggers: gateResult.triggers, findings, trippedFindings, stamp };
}

/**
 * Builds the `before_agent_finalize` handler, or `undefined` when
 * `reflex.enabled` is not explicitly `true` — the caller should skip
 * `api.on("before_agent_finalize", ...)` entirely in that case (see `index.ts`).
 */
export function createReflexFinalizeHandler(
  config: ReflexConfig | undefined,
  options: ReflexFinalizeHookOptions = {},
): ((event: BeforeAgentFinalizeEvent) => Promise<BeforeAgentFinalizeResult>) | undefined {
  if (config?.enabled !== true) return undefined;

  const warrantGate = options.warrantGate ?? createHeuristicWarrantGate();
  const injectionChecker = options.injectionChecker ?? createStubInjectionChecker();
  const logger = options.logger ?? createReflexLogger(config.logPath ?? DEFAULT_REFLEX_LOG_PATH);

  return async function handleBeforeAgentFinalize(
    event: BeforeAgentFinalizeEvent,
  ): Promise<BeforeAgentFinalizeResult> {
    try {
      const turn: ReflexTurnContext = {
        sessionKey: event?.sessionKey,
        runId: event?.runId,
        finalAnswer: extractFinalAnswer(event),
      };
      const evaluation = await evaluateReflexTurn(turn, warrantGate, injectionChecker);
      if (!evaluation.warranted) {
        // "finalize as-is, no tag" — not even logged (issue #1252: only
        // *warranted* turns are appended to reflex-log.jsonl).
        return { action: "finalize" };
      }
      logger.record({
        sessionKey: turn.sessionKey,
        runId: turn.runId,
        warranted: true,
        triggers: evaluation.triggers,
        findings: evaluation.findings,
        stamp: evaluation.stamp,
        reaction: null,
      });
      if (!evaluation.stamp) {
        // Warranted but all clear — finalize as-is (still logged above).
        return { action: "finalize" };
      }
      return {
        action: "revise",
        reason: `reflex-guard: ${evaluation.trippedFindings.length} concern(s) tripped — own and stamp before finalizing`,
        retry: {
          instruction:
            "Amend your final answer: acknowledge and address the following before responding, " +
            `then append this exact stamp verbatim at the end of your answer: ${evaluation.stamp}`,
          maxAttempts: 1,
        },
      };
    } catch (err) {
      // Terminal finalization hook — never block final delivery over the
      // reflex pass's own failure (mirrors the runner's fail-open default
      // for before_agent_finalize; docs/plugins/hooks.md hook-failure table).
      console.error(
        "[reflex-guard] before_agent_finalize handler error:",
        err instanceof Error ? err.message : String(err),
      );
      return { action: "finalize" };
    }
  };
}
