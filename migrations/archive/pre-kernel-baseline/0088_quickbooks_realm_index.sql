-- 0088_quickbooks_realm_index.sql
-- realmId -> { ownerDid, appDid } reverse-lookup index for QuickBooks (xprize #35).
--
-- Intuit's realmId is sealed inside each supplier's token blob
-- (quickbooks-oauth:${ownerDid}), only readable forward. The webhook handler
-- receives a realmId from Intuit and needs to resolve which supplier DID (and
-- which app's config/verifier token) that realm belongs to, without unsealing
-- every supplier's vault entry to find a match.
--
-- Written at exchangeCodeAndStore time (both realmId and ownerDid/appDid are
-- in hand there). Upserted on reconnect so a supplier re-authorizing (same or
-- a different QBO company) always resolves to the current mapping.

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.quickbooks_realm_index (
  realm_id    TEXT PRIMARY KEY,
  owner_did   TEXT NOT NULL,
  app_did     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_realm_index_owner
  ON kernel.quickbooks_realm_index (owner_did);
