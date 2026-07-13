import {
  pgSchema,
  text,
  timestamp,
  jsonb,
  real,
  index,
} from 'drizzle-orm/pg-core';

export const inferenceSchema = pgSchema('inference');

// ---------------------------------------------------------------------------
// inference_sessions
//
// Tracks one full pipeline run per gesture: from capture through consent to
// resolution. Status is the authoritative state machine for the pipeline.
// ---------------------------------------------------------------------------

export const inferenceSessions = inferenceSchema.table(
  'sessions',
  {
    id: text('id').primaryKey(),                          // session_xxx (nanoid)
    ownerDid: text('owner_did').notNull(),
    vocabularyName: text('vocabulary_name').notNull(),    // 'imajin' | 'agrifortress' | …
    assetId: text('asset_id').notNull(),                  // recording / capture asset
    transcript: text('transcript'),                       // pinned after context.ts
    priors: jsonb('priors'),                              // TelemetryPriors (jsonb)
    candidateIntents: jsonb('candidate_intents'),         // CandidateIntent[] (jsonb)
    chosenIntentType: text('chosen_intent_type'),         // set when gate fires
    consentTier: text('consent_tier'),                    // 'silent' | 'itemized' | 'deliberate'
    // Signed owner authorization (deliberate tier) — stored at confirmIntent() time (#1293)
    ownerAuthorization: jsonb('owner_authorization'),
    /**
     * State machine:
     *   capturing → (context) → inferring → (policy) →
     *   pending_confirm | resolving → resolved | failed
     */
    status: text('status').notNull().default('capturing'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    ownerIdx: index('idx_inference_sessions_owner').on(table.ownerDid),
    assetIdx: index('idx_inference_sessions_asset').on(table.assetId),
    statusIdx: index('idx_inference_sessions_status').on(table.status),
    createdIdx: index('idx_inference_sessions_created').on(table.createdAt),
  }),
);

export type InferenceSession = typeof inferenceSessions.$inferSelect;
export type NewInferenceSession = typeof inferenceSessions.$inferInsert;

// ---------------------------------------------------------------------------
// inference_attestations
//
// Signed proof-of-history: one row per successfully resolved intent.
// Every row chains to the source recording's CID so "why did it do that?"
// is answerable from the asset provenance chain.
// ---------------------------------------------------------------------------

export const inferenceAttestations = inferenceSchema.table(
  'attestations',
  {
    id: text('id').primaryKey(),                          // attest_xxx (nanoid)
    sessionId: text('session_id').notNull(),
    ownerDid: text('owner_did').notNull(),
    vocabularyName: text('vocabulary_name').notNull(),
    intentType: text('intent_type').notNull(),
    consentTier: text('consent_tier').notNull(),
    confidence: real('confidence'),                       // model confidence at decision time
    resolutionReceipt: jsonb('resolution_receipt').notNull(), // ResolutionReceipt (jsonb)
    sourceAssetId: text('source_asset_id').notNull(),     // the recording / capture asset
    sourceCid: text('source_cid'),                        // CID of recording at action time
    dfosEventId: text('dfos_event_id'),                   // DFOS anchor for cross-chain verifiability
    // Node signing — #1292
    signature: text('signature'),                         // Ed25519 hex signature over the attestation payload
    senderPubkey: text('sender_pubkey'),                  // hex-encoded Ed25519 public key of the signing node
    // Owner authorization reference — #1293 (copied from session at resolution time)
    ownerAuthorization: jsonb('owner_authorization'),
    signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    ownerIdx: index('idx_inference_attestations_owner').on(table.ownerDid),
    sessionIdx: index('idx_inference_attestations_session').on(table.sessionId),
    sourceAssetIdx: index('idx_inference_attestations_source_asset').on(table.sourceAssetId),
    signedAtIdx: index('idx_inference_attestations_signed_at').on(table.signedAt),
  }),
);

export type InferenceAttestation = typeof inferenceAttestations.$inferSelect;
export type NewInferenceAttestation = typeof inferenceAttestations.$inferInsert;
