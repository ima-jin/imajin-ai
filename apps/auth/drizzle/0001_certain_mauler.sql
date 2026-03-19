ALTER TABLE "auth"."identities" DROP CONSTRAINT "auth_identities_public_key_unique";--> statement-breakpoint
ALTER TABLE "auth"."identities" DROP CONSTRAINT "auth_identities_handle_unique";--> statement-breakpoint
ALTER TABLE "auth"."onboard_tokens" DROP CONSTRAINT "onboard_tokens_token_key";--> statement-breakpoint
ALTER TABLE "auth"."challenges" DROP CONSTRAINT "auth_challenges_identity_id_auth_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "auth"."tokens" DROP CONSTRAINT "auth_tokens_identity_id_auth_identities_id_fk";
--> statement-breakpoint
DROP INDEX "auth"."idx_auth_challenges_expires";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_tokens_identity";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_identities_handle";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_onboard_tokens_email";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_onboard_tokens_token";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_attestations_issuer";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_attestations_subject";--> statement-breakpoint
DROP INDEX "auth"."idx_auth_attestations_type";--> statement-breakpoint
ALTER TABLE "auth"."challenges" ADD CONSTRAINT "challenges_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."tokens" ADD CONSTRAINT "tokens_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auth_challenges_expires" ON "auth"."challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_auth_tokens_identity" ON "auth"."tokens" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "idx_auth_identities_handle" ON "auth"."identities" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_auth_onboard_tokens_email" ON "auth"."onboard_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_auth_onboard_tokens_token" ON "auth"."onboard_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_issuer" ON "auth"."attestations" USING btree ("issuer_did");--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_subject" ON "auth"."attestations" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_type" ON "auth"."attestations" USING btree ("type");--> statement-breakpoint
ALTER TABLE "auth"."identities" ADD CONSTRAINT "identities_public_key_unique" UNIQUE("public_key");--> statement-breakpoint
ALTER TABLE "auth"."identities" ADD CONSTRAINT "identities_handle_unique" UNIQUE("handle");--> statement-breakpoint
ALTER TABLE "auth"."onboard_tokens" ADD CONSTRAINT "onboard_tokens_token_unique" UNIQUE("token");