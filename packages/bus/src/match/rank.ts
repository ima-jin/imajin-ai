import type { CandidateIntent } from './candidates';

const DEFAULT_CAP = 5;

/**
 * Rank surviving candidates by shared-connection count, then cap at top N.
 *
 * Shared-connection count = number of the arriver's 1-hop connections that are
 * also in the candidate's 1-hop connection set — computed from the already-resolved
 * oneDegreeSet (which includes both 1-hop and 2-hop). For simplicity we use set
 * intersection size as the shared-connection proxy.
 *
 * Proximity is a v2 signal (requires location data). Omitted here; all candidates
 * score 0 for proximity so relative order is determined by shared-connection count.
 */
export interface RankedCandidate {
  intent: CandidateIntent;
  sharedConnectionCount: number;
}

export function rankCandidates(
  candidates: CandidateIntent[],
  arriverOneDegreeSet: Set<string>,
  cap: number = DEFAULT_CAP
): RankedCandidate[] {
  const ranked: RankedCandidate[] = candidates.map((intent) => {
    // Shared connections: arriver's 1° set ∩ candidate's DID being in arriver's set
    // is already established. For a richer score we'd need candidate's connection
    // graph too — here we use how many of arriver's 1° connections are the candidate.
    // A full shared-count query would require a second DB lookup (v2).
    // Conservative proxy: 1 if candidate is in arriver's one_degree, else 0.
    const sharedConnectionCount = arriverOneDegreeSet.has(intent.did) ? 1 : 0;
    return { intent, sharedConnectionCount };
  });

  return ranked
    .toSorted((a, b) => b.sharedConnectionCount - a.sharedConnectionCount)
    .slice(0, cap);
}
