/**
 * Tag intersection with OR-sensitivity rule.
 *
 * The set-AND of the two tag lists is the double-blind mechanism:
 * a tag only overlaps if BOTH sides set it independently.
 *
 * OR-sensitivity: if ANY tag in the overlap is marked sensitive by EITHER side,
 * the entire match pair is flagged sensitive. One sensitive tag infects the whole
 * envelope so timing of the sensitive overlap can't leak by contrast.
 */
export interface IntersectResult {
  /** Tags present in both intent's activity_tags. Empty = no match. */
  overlapTags: string[];
  /** True if any overlapping tag is in either side's sensitive_tags. */
  isSensitive: boolean;
}

export function intersectTags(
  arriverTags: string[],
  arriverSensitiveTags: string[],
  candidateTags: string[],
  candidateSensitiveTags: string[]
): IntersectResult {
  const candidateSet = new Set(candidateTags);
  const overlapTags = arriverTags.filter((t) => candidateSet.has(t));

  if (overlapTags.length === 0) {
    return { overlapTags: [], isSensitive: false };
  }

  // OR-sensitivity: any overlap tag in either sensitive set → whole pair sensitive.
  const arriverSensitiveSet = new Set(arriverSensitiveTags);
  const candidateSensitiveSet = new Set(candidateSensitiveTags);
  const isSensitive = overlapTags.some(
    (t) => arriverSensitiveSet.has(t) || candidateSensitiveSet.has(t)
  );

  return { overlapTags, isSensitive };
}
