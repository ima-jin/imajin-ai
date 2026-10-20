-- owner: kernel
-- #2972: OUR meter's conversion provenance, not a counterparty statement.
-- Nullable/additive so old writers and previous-tag rollback remain compatible.
-- Pricing column scaffold generated with drizzle-kit; guarded for replay.
ALTER TABLE usage.incurred ADD COLUMN IF NOT EXISTS pricing JSONB;
--> statement-breakpoint
-- Discoverable internal meter; preserve an existing external adapter owner.
-- Both paths use adapter:warp / external_id=runId, so re-observation dedupes.
INSERT INTO usage.emitters (source, reader, issuer_did, cadence, config, status)
VALUES ('adapter:warp', 'internal', 'did:imajin:platform', 'warp-run-watch',
  '{"externalId":"runId","unit":"warp-credits"}'::jsonb, 'active')
ON CONFLICT (source) DO NOTHING;
