ALTER TABLE "auth"."attestations" ADD COLUMN "cid" text;--> statement-breakpoint
ALTER TABLE "auth"."attestations" ADD COLUMN "author_jws" text;--> statement-breakpoint
ALTER TABLE "auth"."attestations" ADD COLUMN "witness_jws" text;--> statement-breakpoint
ALTER TABLE "auth"."attestations" ADD COLUMN "attestation_status" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "auth"."identities" ADD COLUMN "avatar_asset_id" text;--> statement-breakpoint
ALTER TABLE "auth"."identities" ADD COLUMN "key_roles" jsonb;--> statement-breakpoint
ALTER TABLE "auth"."tokens" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "auth"."tokens" ADD COLUMN "key_role" text;--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_status" ON "auth"."attestations" USING btree ("attestation_status");