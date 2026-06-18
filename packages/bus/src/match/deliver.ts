/**
 * Per-recipient delivery policy for a matched pair.
 *
 * The match is symmetric (exists or not). Notification is asymmetric:
 *
 * named_nudge:      favourite-on-both-sides AND non-sensitive.
 *                   Both are nudged immediately with each other's name.
 *
 * sensitive_staged: ANY tag in the overlap is sensitive.
 *                   Neither is named; "a mutual match exists" surfaced to arriver only.
 *                   Identity withheld until mutual unmask.
 *
 * staged:           1° or strangers, non-sensitive.
 *                   Arriver sees the match first; candidate notified only when
 *                   arriver opts in (mutual unmask).
 *
 * The arriver ALWAYS sees their own matches (they just acted).
 */

export type DeliveryPolicy = 'named_nudge' | 'staged' | 'sensitive_staged';

export interface DeliveryDecision {
  policy: DeliveryPolicy;
  notifyArriver: true;
  notifyCandidate: boolean;
}

/**
 * Determine the delivery policy for a matched pair.
 *
 * @param arriverReach - The arriver's reach setting
 * @param candidateReach - The candidate's reach setting
 * @param arriverFavouritesSet - Set of DIDs the arriver has as favourites
 * @param candidateFavouritesSet - Set of DIDs the candidate has as favourites
 * @param isSensitive - True if any overlapping tag is flagged sensitive
 * @param arriverDid - The arriver's DID
 * @param candidateDid - The candidate's DID
 */
export function deliveryPolicy(
  arriverReach: string,
  candidateReach: string,
  arriverFavouritesSet: Set<string>,
  candidateFavouritesSet: Set<string>,
  isSensitive: boolean,
  arriverDid: string,
  candidateDid: string
): DeliveryDecision {
  // Sensitive overrides everything — never name, never push to candidate.
  if (isSensitive) {
    return { policy: 'sensitive_staged', notifyArriver: true, notifyCandidate: false };
  }

  // named_nudge: both sides have each other as a favourite AND non-sensitive.
  // The value is "we'd have missed each other" — the inner ring gets nudged without
  // having to move first. Favourite-asymmetry is intentional (you set your favourites;
  // mutual is not required for the match, but both must be in each other's favourites
  // for the instant push).
  const arriverHasCandidateAsFavourite = arriverFavouritesSet.has(candidateDid);
  const candidateHasArriverAsFavourite = candidateFavouritesSet.has(arriverDid);

  if (arriverHasCandidateAsFavourite && candidateHasArriverAsFavourite) {
    return { policy: 'named_nudge', notifyArriver: true, notifyCandidate: true };
  }

  // staged: 1° or strangers — surface to arriver first; candidate learns on opt-in.
  return { policy: 'staged', notifyArriver: true, notifyCandidate: false };
}
