-- 0111_stripe_webhook_index.sql
-- routingId -> { ownerDid, endpointId } lookup index for the Stripe
-- BYO-restricted-key connector (#1785).
--
-- Each owner self-provisions their OWN Stripe webhook endpoint with their own
-- restricted key. A direct-account Stripe event carries no owner-identifying
-- field, so the kernel embeds an opaque routing id in the URL it registers
-- with Stripe (/stripe/api/webhook/{routing_id}) and indexes it here to
-- resolve a delivery back to the owning DID (and the endpoint id needed to
-- deprovision on disconnect) before anything is trusted.
--
-- One row per owner (unique on owner_did): reconnecting/rotating the key
-- upserts by owner, so a stale routing id from a superseded endpoint can
-- never resolve again.

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.stripe_webhook_index (
  routing_id   TEXT PRIMARY KEY,
  owner_did    TEXT NOT NULL,
  endpoint_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_stripe_webhook_index_owner
  ON kernel.stripe_webhook_index (owner_did);
