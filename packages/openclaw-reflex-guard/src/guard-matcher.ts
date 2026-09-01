/**
 * Layer 1 pattern/string scan (issue #1252: "Pattern/string scan of outbound
 * messages against a configurable sealed-term list. Block-or-flag on
 * match. No LLM call."). Pure functions only — no I/O — so the block/flag
 * decision logic is trivially unit-testable independent of any hook wiring.
 */
import type { CompiledSealedTerm } from "./guard-config.js";

export interface GuardMatch {
  termId: string;
  action: "block" | "flag";
}

export interface GuardScanResult {
  /** Every term that matched, in term order — not just the first. */
  matches: GuardMatch[];
  /** "block" wins over "flag": a single blocking trip is enough to hold the content. */
  action: "block" | "flag" | "none";
}

/** Scans `content` against every compiled term, collecting every trip. */
export function scanForSealedTerms(content: string, terms: CompiledSealedTerm[]): GuardMatch[] {
  if (!content) return [];
  const matches: GuardMatch[] = [];
  for (const term of terms) {
    try {
      if (term.test(content)) {
        matches.push({ termId: term.id, action: term.action });
      }
    } catch {
      // `compileTerm` (guard-config.ts) validates regex sources up front, so
      // a compiled term's `test` should never throw — but a scan must never
      // crash the outbound pipeline over a single misbehaving matcher.
    }
  }
  return matches;
}

/** "block" wins over "flag" when both are present among the matches. */
export function resolveScanAction(matches: GuardMatch[]): "block" | "flag" | "none" {
  if (matches.length === 0) return "none";
  return matches.some((match) => match.action === "block") ? "block" : "flag";
}

export function scanOutboundContent(content: string, terms: CompiledSealedTerm[]): GuardScanResult {
  const matches = scanForSealedTerms(content, terms);
  return { matches, action: resolveScanAction(matches) };
}
