/**
 * Layer 2 scaffold types — the warrant-gate -> injection-check -> own-and-
 * stamp flow described in issue #1252. This module defines the shapes only;
 * `src/reflex-warrant-gate.ts` implements the (heuristic, non-LLM) warrant
 * gate and `src/reflex-injection-check.ts` stubs the LLM-judgment step.
 */

/** Concern list seeded from SOUL.md/MEMORY.md doctrines (issue #1252). */
export const REFLEX_CONCERNS = [
  "honesty",
  "contradiction",
  "voice",
  "overclaim",
  "smell-surface",
  "grade-your-own-homework",
  "stale-assumption",
] as const;

export type ReflexConcern = (typeof REFLEX_CONCERNS)[number];

/** Trigger features the warrant gate keys off (issue #1252, "Warrant-gate trigger features"). */
export const WARRANT_TRIGGERS = [
  "external-send",
  "artifact-produced",
  "commitment-asserted",
  "direction-changed",
] as const;

export type WarrantTrigger = (typeof WARRANT_TRIGGERS)[number];

/** Minimal turn context the warrant gate and injection check reason over. */
export interface ReflexTurnContext {
  sessionKey?: string;
  runId?: string;
  /** The natural final answer `before_agent_finalize` is inspecting. */
  finalAnswer: string;
  /** Recent session messages, most-recent-last, when the host provides them. */
  recentMessages?: Array<{ role?: string; content?: string }>;
}

export interface WarrantGateResult {
  warranted: boolean;
  triggers: WarrantTrigger[];
}

/** Cheap, non-LLM check for "is this moment worth checking" (issue #1252: "leans PERMISSIVE"). */
export interface WarrantGate {
  evaluate(turn: ReflexTurnContext): WarrantGateResult;
}

export interface ConcernFinding {
  concern: ReflexConcern;
  tripped: boolean;
  rationale?: string;
}

/**
 * The LLM-judgment step (issue #1252 Layer 2 "injection check"). Stubbed for
 * a follow-up in this PR: the v0 REFLEX.md discipline's log is the intended
 * spec input for this step's prompt/concern-weighting, and per the issue's
 * 2026-07-29 status check that log is currently dead (3 entries, all from
 * its creation day) — there is no labeled data to build the real judgment
 * against yet. See `src/reflex-injection-check.ts`.
 */
export interface InjectionChecker {
  checkConcerns(turn: ReflexTurnContext, triggers: WarrantTrigger[]): Promise<ConcernFinding[]>;
}

/** Outcome of running the full Layer 2 pipeline for one turn. */
export interface ReflexEvaluation {
  warranted: boolean;
  triggers: WarrantTrigger[];
  findings: ConcernFinding[];
  /** Concerns that actually tripped, capped at 2 per turn (issue #1252: "max 2 surfaced per turn"). */
  trippedFindings: ConcernFinding[];
  /** `<beta>` stamp text when at least one concern tripped; absent otherwise. */
  stamp?: string;
}

export interface ReflexLogEntry {
  ts: string;
  sessionKey?: string;
  runId?: string;
  warranted: boolean;
  triggers: WarrantTrigger[];
  findings: ConcernFinding[];
  stamp?: string;
  /** Backfilled later from a 👍/👎 reaction on the `<beta>` stamp. Feedback capture is deferred — see PR body. */
  reaction?: "up" | "down" | null;
}
