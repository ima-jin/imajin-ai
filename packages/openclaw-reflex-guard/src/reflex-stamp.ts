/**
 * Builds the inline `<beta> … [👍/👎]` stamp (issue #1252 Layer 2: "Inline
 * `<beta> … [👍/👎]` stamp at the point the check acted").
 */
import type { ConcernFinding } from "./reflex-types.js";

/** Issue #1252: "max 2 surfaced per turn". */
export const MAX_STAMPED_CONCERNS = 2;

/**
 * Selects which tripped concerns get surfaced inline. Additional trips
 * beyond `MAX_STAMPED_CONCERNS` are still fully recorded in `reflex-log.jsonl`
 * (see `src/reflex-log.ts`) — only the inline stamp is capped, to keep it
 * from crowding out the turn's actual answer.
 */
export function selectStampedFindings(findings: ConcernFinding[]): ConcernFinding[] {
  return findings.filter((finding) => finding.tripped).slice(0, MAX_STAMPED_CONCERNS);
}

function formatFinding(finding: ConcernFinding): string {
  const rationale = finding.rationale?.trim();
  return rationale ? `${finding.concern}: ${rationale}` : finding.concern;
}

/**
 * Returns the `<beta>` stamp text, or `undefined` when no concern tripped
 * (issue #1252: "all clear → finalize as-is", no tag).
 */
export function buildBetaStamp(findings: ConcernFinding[]): string | undefined {
  const stamped = selectStampedFindings(findings);
  if (stamped.length === 0) return undefined;
  const body = stamped.map(formatFinding).join("; ");
  return `<beta> ${body} [👍/👎]`;
}
