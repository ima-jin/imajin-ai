-- Migration: 0069_inference_owner_authorization
-- Adds owner_authorization (jsonb) to inference.sessions and inference.attestations (#1293).
--
-- When a deliberate-tier session is confirmed, the node signs the authorization
-- payload { sessionId, chosenIntentType, candidateDigest, ts } on behalf of the
-- owner and stores it as { payload, signature, senderPubkey } here.
-- The signed authorization is then carried into the inference_attestations row so
-- "the human permitted it" is provable alongside "the node executed it" (#1292).
--
-- Nullable: silent-tier sessions never produce an authorization.

ALTER TABLE inference.sessions
  ADD COLUMN IF NOT EXISTS owner_authorization jsonb;

ALTER TABLE inference.attestations
  ADD COLUMN IF NOT EXISTS owner_authorization jsonb;
