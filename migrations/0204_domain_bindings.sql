-- owner: kernel
-- Generated with drizzle-kit from schemas/domains.ts; idempotency guards added.
CREATE TABLE IF NOT EXISTS "auth"."domain_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"zone_owner" text NOT NULL,
	"site_owner" text NOT NULL,
	"app_did" text,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attestation" jsonb,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_domain_binding_claim" ON "auth"."domain_bindings" USING btree ("domain","zone_owner");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_domain_binding_verified" ON "auth"."domain_bindings" USING btree ("domain") WHERE "auth"."domain_bindings"."status" IN ('verified', 'legacy');
CREATE INDEX IF NOT EXISTS "idx_domain_bindings_zone_owner" ON "auth"."domain_bindings" USING btree ("zone_owner");
CREATE INDEX IF NOT EXISTS "idx_domain_bindings_site_owner" ON "auth"."domain_bindings" USING btree ("site_owner");
CREATE INDEX IF NOT EXISTS "idx_domain_bindings_recheck" ON "auth"."domain_bindings" USING btree ("checked_at") WHERE "auth"."domain_bindings"."status" = 'verified' AND "auth"."domain_bindings"."method" = 'dns-txt';

-- #614 custom_domain existed on some deployed databases, but not main.
-- Preserve existing routes only: no TXT proof or attestation is invented.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'profile' AND table_name = 'forest_config' AND column_name = 'custom_domain'
  ) THEN
    RAISE WARNING 'Grandfathering legacy custom_domain routes WITHOUT verified ownership evidence; owners must verify DNS';
    EXECUTE $backfill$
      INSERT INTO auth.domain_bindings (id, domain, zone_owner, site_owner, method, status)
      SELECT 'legacy_' || md5(group_did || custom_domain),
             lower(rtrim(custom_domain, '.')), group_did, group_did, 'legacy', 'legacy'
      FROM profile.forest_config
      WHERE custom_domain IS NOT NULL
        AND length(custom_domain) <= 254
        AND custom_domain ~ '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?[.]?$'
        AND custom_domain LIKE '%.%'
      ON CONFLICT DO NOTHING
    $backfill$;
  END IF;
END
$migration$;
