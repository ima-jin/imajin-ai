import {
  pgSchema,
  text,
  timestamp,
  jsonb,
  real,
  integer,
  numeric,
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
    appDid: text('app_did'),
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
     * Human-edited/confirmed metadata for the chosen intent, set at confirm
     * time when the caller POSTs an edited payload (#1789). `candidateIntents`
     * above always keeps the ORIGINAL inferred metadata untouched — this column
     * is the correction, so the guess-vs-approval delta stays auditable. Null
     * when confirm was called with no body (current/default behavior).
     */
    confirmedMetadata: jsonb('confirmed_metadata'),
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
    appIdx: index('idx_inference_sessions_app').on(table.appDid),
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
    // Inferred vs confirmed metadata delta (#1789) — signed into the attestation
    // payload below so "the engine guessed X, the human corrected to Y" is
    // itself part of the auditable, signed record. Equal when nothing was edited.
    inferredMetadata: jsonb('inferred_metadata'),
    confirmedMetadata: jsonb('confirmed_metadata'),
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

// ---------------------------------------------------------------------------
// inference_usage (#1923, Phase 3 of #1922)
//
// Per-turn metering ledger: ONE row per completions-passthrough call
// (`POST /infer/v1/chat/completions`, #1925). Granular token-level records
// live here; the money lives in `pay.transactions` (`service = 'inference'`)
// and the daily aggregate in `pay.balance_rollups` — see
// migrations/0119_inference_usage.sql for the full division-of-responsibility
// note. Not a place to store cost/spend totals — those are derived by
// summing this table (spend-cap enforcement) or read from the pay schema
// (dashboard burn-down).
// ---------------------------------------------------------------------------

export const inferenceUsage = inferenceSchema.table(
  'usage',
  {
    id: text('id').primaryKey(),                          // usage_xxx (nanoid)
    sessionId: text('session_id'),                        // X-Session-Id header (OpenClaw); null when absent
    turnId: text('turn_id'),                              // X-Turn-Id header; null when absent
    principalDid: text('principal_did').notNull(),        // owner DID whose sealed card supplied the credential
    agentDid: text('agent_did'),                          // invoking app DID (onBehalfOf); null when the owner called directly
    provider: text('provider').notNull(),                 // BRAIN_CONNECTORS id, e.g. 'xai'
    connectorId: text('connector_id'),                    // kernel.connectors.id this call resolved credentials from
    model: text('model').notNull(),
    tokensIn: integer('tokens_in'),                       // null when the upstream response never reported usage
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 20, scale: 8 }), // null when tokens are unknown or the model has no pricing entry
    transactionId: text('transaction_id'),                // pay.transactions.id this call's spend was recorded under
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalIdx: index('idx_inference_usage_principal').on(table.principalDid, table.createdAt),
    agentIdx: index('idx_inference_usage_agent').on(table.agentDid, table.createdAt),
    sessionIdx: index('idx_inference_usage_session').on(table.sessionId),
    turnIdx: index('idx_inference_usage_turn').on(table.turnId),
    connectorIdx: index('idx_inference_usage_connector').on(table.connectorId, table.createdAt),
    createdIdx: index('idx_inference_usage_created').on(table.createdAt),
  }),
);

export type InferenceUsage = typeof inferenceUsage.$inferSelect;
export type NewInferenceUsage = typeof inferenceUsage.$inferInsert;
