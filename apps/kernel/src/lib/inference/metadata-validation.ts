/**
 * Generic metadata validation seam for the confirm route (#1789).
 *
 * The confirm route accepts an optional human-edited/confirmed payload that
 * must be validated against the resolved intent's expected shape before it's
 * allowed to replace the inferred metadata. This module implements that
 * generically against the `IntentVocabulary` contract — it never special-cases
 * a single tenant vocabulary.
 */

import type { IntentVocabulary, MetadataValidationResult } from './types';

/**
 * Validate a confirmed metadata payload for `intentType` against `vocab`.
 *
 * Delegates to `vocab.validateMetadata` when the tenant implements it — each
 * vocabulary owns its own intent metadata shape, per the IntentVocabulary
 * boundary (#1216). Falls back to a generic structural check for vocabularies
 * that don't implement the hook, so confirm can still fail closed on the one
 * shape every metadata payload must satisfy: `CandidateIntent.metadata` is
 * `Record<string, unknown>`.
 */
export function validateConfirmedMetadata(
  vocab: IntentVocabulary,
  intentType: string,
  metadata: unknown,
): MetadataValidationResult {
  if (vocab.validateMetadata) {
    try {
      return vocab.validateMetadata(intentType, metadata);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  return validatePlainMetadataObject(metadata);
}

/** Generic contract-level check: metadata must be a plain JSON object. */
function validatePlainMetadataObject(metadata: unknown): MetadataValidationResult {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { ok: false, error: 'metadata must be a JSON object' };
  }
  return { ok: true, metadata: metadata as Record<string, unknown> };
}
