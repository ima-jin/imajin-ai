-- owner: kernel
-- #2972: Additive physical run ledger under the logical usage.billed relation.
-- Parent reads include inherited rows automatically. The old parent's indexes
-- and exact generic ON CONFLICT target remain untouched, including on rollback.
-- Distinct runs can share period_start/model; only this child's id PK dedupes.
-- Shared column builders in usage.ts describe both relations. drizzle-kit can
-- scaffold the child columns/indexes but cannot emit PostgreSQL INHERITS; this
-- explicit inheritance DDL is migration-owned and covered by real SQL tests.
-- Columns/defaults/NOT NULL propagate from parent; PKs/FKs/indexes do not.
-- Reserved billed_warp_ IDs separate this writer from generated parent IDs.
CREATE TABLE IF NOT EXISTS usage.billed_warp_runs (
  CONSTRAINT billed_warp_runs_pkey PRIMARY KEY (id),
  CONSTRAINT usage_billed_warp_runs_kind CHECK
    (provider = 'warp' AND source = 'api' AND granularity = 'run' AND currency = 'USD')
) INHERITS (usage.billed);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_billed_warp_runs_principal
  ON usage.billed_warp_runs (principal_did, provider, period_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_billed_warp_runs_fetched
  ON usage.billed_warp_runs (fetched_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_billed_warp_runs_source
  ON usage.billed_warp_runs (principal_did, source, period_start);
