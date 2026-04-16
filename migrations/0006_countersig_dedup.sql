-- 0005_countersig_dedup.sql
-- Fix countersignature duplication on peer-sync ingestion
-- Bug: same countersig arriving from multiple peers stored multiple times
-- Fix: add witness_did column + unique constraint, DB-level dedup

-- Add witness_did column
ALTER TABLE relay.relay_countersignatures
  ADD COLUMN IF NOT EXISTS witness_did TEXT;

-- Backfill witness_did from existing JWS tokens where possible
-- The kid header format is "did:dfos:xxx#key_yyy" — extract everything before '#'
UPDATE relay.relay_countersignatures
SET witness_did = split_part(
  -- Extract kid from JWS header (base64url-decoded first segment)
  -- This is best-effort; tokens that can't be parsed keep NULL
  convert_from(
    decode(
      replace(replace(
        split_part(jws_token, '.', 1),
        '-', '+'), '_', '/') ||
        repeat('=', (4 - length(split_part(jws_token, '.', 1)) % 4) % 4),
      'base64'),
    'UTF8')::jsonb->>'kid',
  '#', 1)
WHERE witness_did IS NULL;

-- Remove duplicates before adding unique constraint
-- Keep the row with the lowest id for each (operation_cid, witness_did) pair
DELETE FROM relay.relay_countersignatures a
USING relay.relay_countersignatures b
WHERE a.operation_cid = b.operation_cid
  AND a.witness_did IS NOT NULL
  AND a.witness_did = b.witness_did
  AND a.id > b.id;

-- Add unique constraint (nulls are distinct, so rows without witness_did won't conflict)
CREATE UNIQUE INDEX IF NOT EXISTS uq_relay_countersignatures_op_witness
  ON relay.relay_countersignatures (operation_cid, witness_did);
