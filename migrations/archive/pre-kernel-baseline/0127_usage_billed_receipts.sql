-- 0127_usage_billed_receipts.sql
-- Receipt upload path for non-API costs (#1951, COGS D3/D4 of #1075) — the
-- multi-line-item write path over `usage.billed` (0122 + 0125). Never a new
-- table, never `usage.incurred` (D5): a receipt with N line items writes N
-- `usage.billed` rows sharing one `receipt_id`, plus one binding attestation
-- over the whole receipt (see lib/usage/billed/receipt.ts).
--
-- `receipt_id` / `line_no` group and order the line items an uploaded
-- receipt was split into — 0125's `source` column already distinguishes the
-- write path ('receipt:manual', added here as an accepted value, no new
-- column needed for that); these two are the "e.g. asset_id, line_no" the
-- issue anticipated. `asset_id` itself is NOT a new column: 0125's
-- `evidence_asset_id` / `evidence_content_hash` already bind a row to a
-- media asset + its content hash, and a receipt line is exactly that
-- binding, so the receipt writer reuses those columns rather than forking a
-- second pair with the same meaning.
--
-- `receipt_total_minor` is the receipt's declared total (same currency as
-- the row's `currency`) that D3's signed-sum invariant checked this line's
-- siblings against at write time — denormalized onto every line of the
-- receipt for read convenience, since sum-checking already required loading
-- them together.
--
-- `fx_*` persists the signed `FxSnapshot` (`packages/money`, #1950) used to
-- compute this row's `billed_usd` when `currency <> 'USD'` — "the snapshot
-- is part of the signed row" per #1951's scope note. NULL for USD rows
-- (identity conversion, nothing to prove) and for every pre-existing row.
-- `fx_base` is not its own column: it is always this row's own `currency`,
-- and `fx_quote` is always 'USD' (what `billed_usd` already means), so
-- storing either would only duplicate an existing column.

ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS receipt_id TEXT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS line_no INTEGER;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS receipt_total_minor BIGINT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(24, 10);
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS fx_source TEXT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS fx_as_of DATE;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS fx_signature TEXT;

-- Receipt read: every line item belonging to one uploaded receipt, in order.
CREATE INDEX IF NOT EXISTS idx_usage_billed_receipt
  ON usage.billed (principal_did, receipt_id, line_no)
  WHERE receipt_id IS NOT NULL;
