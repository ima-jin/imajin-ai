-- owner: kernel
-- #2972: Warp uses a deterministic principal/run primary key, not a model hack.
-- Two distinct runs can share period_start and model, so run rows must not
-- participate in the provider-bucket unique index.
-- Generated with drizzle-kit generate from usage.ts; guarded for repeatability.
-- Generic bucket upserts must specify WHERE granularity <> 'run' when
-- targeting this partial index. Deploy that ingest change with this migration.
DROP INDEX IF EXISTS "usage"."uniq_usage_billed_period";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_usage_billed_period"
  ON "usage"."billed" USING btree
    ("principal_did", "provider", "period_start", "granularity", COALESCE("model", ''))
  WHERE "granularity" <> 'run';
