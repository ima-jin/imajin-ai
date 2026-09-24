-- Migration: 0158_media_asset_doc_edges
-- owner: kernel
-- #2282 (PR #2185 addendum items 4-6) — doc->asset edges for .fair
-- derivative tracking. POST /media/api/assets/bundle materializes N files
-- plus an index markdown doc, rewriting the doc's local image/link refs to
-- the uploaded assets' URLs. This small join table records which assets a
-- doc embeds so future .fair derivative-tracking queries don't have to
-- re-parse markdown to answer "what does this doc depend on".

CREATE TABLE IF NOT EXISTS media.asset_doc_edges (
  id            text        PRIMARY KEY,
  doc_asset_id  text        NOT NULL REFERENCES media.assets(id) ON DELETE CASCADE,
  asset_id      text        NOT NULL REFERENCES media.assets(id) ON DELETE CASCADE,
  relation      text        NOT NULL DEFAULT 'embeds',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_asset_doc_edge UNIQUE (doc_asset_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_doc_edges_doc
  ON media.asset_doc_edges (doc_asset_id);

CREATE INDEX IF NOT EXISTS idx_asset_doc_edges_asset
  ON media.asset_doc_edges (asset_id);
