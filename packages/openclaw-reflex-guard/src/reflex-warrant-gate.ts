/**
 * Default warrant gate (issue #1252: "cheap, leans PERMISSIVE" — deterministic,
 * no LLM call). Detects the four trigger features from the issue via cheap
 * keyword/pattern heuristics on the turn's final answer text.
 *
 * Asymmetry rule (issue #1252): "a false NO is the expensive failure; a
 * false YES is a cheap scan. When unsure, warrant it." These heuristics are
 * therefore deliberately generous — a false positive here only costs one
 * extra (currently-stubbed, see `src/reflex-injection-check.ts`) injection
 * check call, never a missed one.
 */
import type { ReflexTurnContext, WarrantGate, WarrantGateResult, WarrantTrigger } from "./reflex-types.js";

const EXTERNAL_SEND_HINTS = [
  /\bpost(ed|ing)?\b/i,
  /\bsend(ing)?\b/i,
  /\bpublish(ed|ing)?\b/i,
  /\bemail(ed|ing)?\b/i,
  /\bcomment(ed|ing)?\b/i,
  /\btweet(ed|ing)?\b/i,
];
const ARTIFACT_HINTS = [
  /\bpull request\b/i,
  /\bpr #?\d+/i,
  /\bcommit(ted)?\b/i,
  /\bgist\b/i,
  /\bissue #?\d+/i,
  /\b(created|wrote|written)\b.*\bfiles?\b/i,
];
const COMMITMENT_HINTS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d+%\b/,
  /\bwill (ship|deliver|finish|complete)\b/i,
  /\bguarantee[sd]?\b/i,
  /\bis (done|complete|finished)\b/i,
];
const DIRECTION_CHANGE_HINTS = [
  /\binstead\b/i,
  /\brather than\b/i,
  /\bchang(ed|ing) (my|the) (mind|approach|plan)\b/i,
  /\bon second thought\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectExternalSend(text: string): boolean {
  return matchesAny(text, EXTERNAL_SEND_HINTS);
}
export function detectArtifactProduced(text: string): boolean {
  return matchesAny(text, ARTIFACT_HINTS);
}
export function detectCommitmentAsserted(text: string): boolean {
  return matchesAny(text, COMMITMENT_HINTS);
}
export function detectDirectionChanged(text: string): boolean {
  return matchesAny(text, DIRECTION_CHANGE_HINTS);
}

const TRIGGER_DETECTORS: Record<WarrantTrigger, (text: string) => boolean> = {
  "external-send": detectExternalSend,
  "artifact-produced": detectArtifactProduced,
  "commitment-asserted": detectCommitmentAsserted,
  "direction-changed": detectDirectionChanged,
};

/** Evaluates every trigger feature against the given text, in `WARRANT_TRIGGERS` order. */
export function evaluateWarrantTriggers(text: string): WarrantTrigger[] {
  const triggers: WarrantTrigger[] = [];
  for (const [trigger, detect] of Object.entries(TRIGGER_DETECTORS) as [
    WarrantTrigger,
    (t: string) => boolean,
  ][]) {
    if (detect(text)) triggers.push(trigger);
  }
  return triggers;
}

/**
 * Any detected trigger warrants the turn; an empty/unparseable final answer
 * does not (there is nothing to check).
 */
export function createHeuristicWarrantGate(): WarrantGate {
  return {
    evaluate(turn: ReflexTurnContext): WarrantGateResult {
      const text = typeof turn?.finalAnswer === "string" ? turn.finalAnswer : "";
      if (!text) return { warranted: false, triggers: [] };
      const triggers = evaluateWarrantTriggers(text);
      return { warranted: triggers.length > 0, triggers };
    },
  };
}
