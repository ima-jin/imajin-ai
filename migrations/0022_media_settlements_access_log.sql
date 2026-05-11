-- .fair HTTP 402 settlement support (#883)
-- Creates settlements and access_log tables under media schema

CREATE TABLE IF NOT EXISTS media.settlements (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    action TEXT NOT NULL,
    buyer_did TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    scheme TEXT NOT NULL,
    receipt_token TEXT NOT NULL,
    external_receipt_id TEXT,
    fair_manifest_digest TEXT NOT NULL,
    dfos_event_id TEXT,
    settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlements_asset ON media.settlements(asset_id);
CREATE INDEX IF NOT EXISTS idx_settlements_buyer ON media.settlements(buyer_did);
CREATE INDEX IF NOT EXISTS idx_settlements_dfos ON media.settlements(dfos_event_id);
CREATE INDEX IF NOT EXISTS idx_settlements_settled_at ON media.settlements(settled_at);

CREATE TABLE IF NOT EXISTS media.access_log (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    action TEXT NOT NULL,
    settlement_id TEXT,
    buyer_did TEXT,
    ip TEXT,
    user_agent TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_log_asset ON media.access_log(asset_id);
CREATE INDEX IF NOT EXISTS idx_access_log_buyer ON media.access_log(buyer_did);
CREATE INDEX IF NOT EXISTS idx_access_log_at ON media.access_log(at);
