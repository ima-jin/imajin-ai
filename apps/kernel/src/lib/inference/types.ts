/**
 * Intention Inference Engine — shared types (#1198).
 *
 * CaptureKind → CaptureEvent → InferenceContext → CandidateIntent[]
 * → ConsentTier gate → ResolutionReceipt → signed attestation.
 *
 * The IntentVocabulary interface is the pluggable tenant contract (#1216).
 * Tenants import it from vocabulary/contract.ts — never from Imajin internals.
 */

// ---------------------------------------------------------------------------
// Capture surface (#1211)
// ---------------------------------------------------------------------------

export type CaptureKind = 'voice' | 'photo' | 'file' | 'text';

export interface CaptureEvent {
  /** Stable pipeline run ID (session_xxx). */
  sessionId: string;
  /** Media asset created from the gesture. */
  assetId: string;
  /** Kind of gesture that was captured. */
  kind: CaptureKind;
  /** Owner DID the asset and session are pinned to. */
  ownerDid: string;
}

// ---------------------------------------------------------------------------
// Telemetry / context gather (#1212)
// ---------------------------------------------------------------------------

export interface TelemetryPriors {
  /** DIDs of the owner's most recent active connections (read-only, consent-respecting). */
  recentConnectionDids: string[];
  /** Coarse time-of-day bucket derived from wall clock. */
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  /**
   * Free-text activity summary — v1 stub; populated by calendar + events in later
   * iterations.
   */
  recentActivitySummary: string;
}

export interface InferenceContext {
  sessionId: string;
  assetId: string;
  /** Transcript of the voice note (or raw text for text captures). */
  transcript: string;
  priors: TelemetryPriors;
}

// ---------------------------------------------------------------------------
// Consent tiers (#1214, consumes #1196)
// ---------------------------------------------------------------------------

/**
 * Consent tier for an inferred intent.
 *
 * - silent    → may resolve without any user prompt (read-your-own, notes-to-self).
 * - itemized  → shows a summary before acting; user may dismiss without explicit tap.
 * - deliberate → requires an explicit confirm tap before the action fires (boundary-
 *               crossing: disclose / send / spend). The AgriFortress one-confirm
 *               gate is deliberate.
 */
export type ConsentTier = 'silent' | 'itemized' | 'deliberate';

// ---------------------------------------------------------------------------
// Inference policy (#1213)
// ---------------------------------------------------------------------------

export interface CandidateIntent {
  /** Stable string identifier for this intent type in the mounted vocabulary. */
  intentType: string;
  /** Model confidence 0–1. */
  confidence: number;
  /**
   * Vocabulary-specific structured payload extracted from the transcript + priors.
   * e.g. for AgriFortress: { product: string, qty: number, recipient: string }
   */
  metadata: Record<string, unknown>;
  /** Consent tier resolved by vocab.resolveConsentTier(intentType). */
  consentTier: ConsentTier;
}

// ---------------------------------------------------------------------------
// Primitive resolution + signing (#1215)
// ---------------------------------------------------------------------------

export interface ResolutionReceipt {
  /** Primitive or domain action type that was executed. */
  primitiveType: string;
  /** External record/transaction ID returned by the resolution target (optional). */
  externalId?: string;
  /** sha256 hex digest of the receipt payload (for content-addressing). */
  digest: string;
  /** ISO timestamp of resolution. */
  resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Pluggable vocabulary contract (#1216)
// ---------------------------------------------------------------------------

/**
 * The interface a tenant implements to mount the inference shell.
 *
 * Hard boundary rules:
 *  - resolve() receives ONLY CandidateIntent + ownerDid. It MUST NOT import
 *    any Imajin kernel internals.
 *  - Imajin's own vocabulary MUST NOT import any tenant domain logic.
 *  - Machine-only runtimes MUST NOT mount this interface.
 */
export interface IntentVocabulary {
  /** Stable tenant identifier, e.g. 'imajin' | 'agrifortress'. */
  name: string;
  /** Provider for @imajin/llm getModel() — selects the model adapter. */
  modelProvider: 'anthropic' | 'openai' | 'ollama';
  /** Model ID for the inference call, e.g. 'claude-sonnet-4-20250514'. */
  modelId: string;
  /**
   * Vocab-specific system prompt fragment injected into the policy call.
   * Should describe the available intent types and the expected JSON output
   * schema in terms meaningful to this vocabulary.
   */
  systemPrompt: string;
  /**
   * Map an intent type string to its consent tier.
   * Called by policy.ts to enrich each CandidateIntent.
   */
  resolveConsentTier(intentType: string): ConsentTier;
  /**
   * Execute the intent onBehalfOf the owner: call domain APIs / kernel
   * primitives and return a ResolutionReceipt. Called only after the
   * appropriate consent gate has been satisfied.
   *
   * MUST NOT import Imajin kernel internals.
   */
  resolve(intent: CandidateIntent, ownerDid: string): Promise<ResolutionReceipt>;
}
