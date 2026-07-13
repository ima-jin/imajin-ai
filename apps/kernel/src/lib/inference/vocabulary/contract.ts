/**
 * Pluggable vocabulary contract (#1216).
 *
 * This is the ONLY file a tenant needs to import from the Imajin inference
 * shell. Tenants implement IntentVocabulary and pass it to the shell via the
 * API or MCP tool — they never import Imajin kernel internals directly.
 *
 * Hard boundary:
 *   - resolve() must not import Imajin kernel internals.
 *   - Machine-only runtimes must not mount this interface.
 *   - Imajin's own vocabulary must not import any tenant domain logic.
 */
export type {
  IntentVocabulary,
  CandidateIntent,
  ConsentTier,
  ResolutionReceipt,
} from '../types';
