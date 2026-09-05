/**
 * Typed errors for the corpus engine (#1921's sha-pinned snapshot queries).
 *
 * Kept separate from `types.ts` (data shapes) so `routes.ts` can `instanceof`
 * check against a stable, purpose-built error class instead of pattern
 * matching on a message string.
 */

/**
 * Thrown by `CorpusStore.searchAtRef` when `(source, ref)` has no recorded
 * snapshot manifest — i.e. no ingest has ever run against that ref. Mapped
 * to an HTTP 404 by `routes.ts`, never a silent fallback to HEAD.
 */
export class UnknownRefError extends Error {
  constructor(
    public readonly source: string,
    public readonly ref: string,
  ) {
    super(`No indexed snapshot for source "${source}" at ref "${ref}". Trigger ingest at this ref first.`);
    this.name = 'UnknownRefError';
  }
}
