-- 0058_seed_document_changed_chain.sql
-- Seed the bus chain config for document.changed (Issue #1205, EPIC #1204).
--
-- document.changed is the authored-document change trigger (the control-plane
-- "button"): editing a tracked authored doc (markdown/YAML) republishes it via
-- publish('document.changed', { path, cid, prevCid }) from the shared media
-- write path (updateAssetContent). Hot-state writes never fire it (rule 1).
--
-- Emit-only initially. The release-gated projection reactor (#1207) attaches
-- downstream; this row mirrors the hardcoded DEFAULTS fallback in
-- packages/bus/src/config.ts so runtime behavior is identical whether or not
-- the DB row is present.

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'document.changed',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
