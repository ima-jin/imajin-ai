-- #1122 Bundle 2: Add cid column to media.assets (Layer A — content identity)
-- CIDv1 dag-cbor+sha256 (base32lower, e.g. bafyrei...) computed over raw file bytes.
-- NULL for assets uploaded before Bundle 2.
-- Distinct from lore_ref (Lore storage pointer, Layer B) — they are parallel identifiers.
-- An index is added for global CID-based dedup lookups in the upload path.
ALTER TABLE media.assets
  ADD COLUMN IF NOT EXISTS cid TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_cid
  ON media.assets (cid)
  WHERE cid IS NOT NULL AND status = 'active';
