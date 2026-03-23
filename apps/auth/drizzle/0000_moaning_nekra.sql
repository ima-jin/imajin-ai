CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "auth"."attestations" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer_did" text NOT NULL,
	"subject_did" text NOT NULL,
	"type" text NOT NULL,
	"context_id" text,
	"context_type" text,
	"payload" jsonb,
	"signature" text NOT NULL,
	"cid" text,
	"author_jws" text,
	"witness_jws" text,
	"attestation_status" text DEFAULT 'pending',
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "auth"."credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "auth"."identities" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"public_key" text NOT NULL,
	"handle" text,
	"name" text,
	"avatar_url" text,
	"avatar_asset_id" text,
	"tier" text DEFAULT 'soft' NOT NULL,
	"key_roles" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "identities_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "identities_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "auth"."identity_chains" (
	"did" text PRIMARY KEY NOT NULL,
	"dfos_did" text NOT NULL,
	"log" jsonb NOT NULL,
	"head_cid" text NOT NULL,
	"key_count" integer DEFAULT 1 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "identity_chains_dfos_did_unique" UNIQUE("dfos_did")
);
--> statement-breakpoint
CREATE TABLE "auth"."onboard_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"token" text NOT NULL,
	"redirect_url" text,
	"context" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "onboard_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"key_id" text,
	"key_role" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth"."challenges" ADD CONSTRAINT "challenges_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."identity_chains" ADD CONSTRAINT "identity_chains_did_identities_id_fk" FOREIGN KEY ("did") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."tokens" ADD CONSTRAINT "tokens_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_subject" ON "auth"."attestations" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_issuer" ON "auth"."attestations" USING btree ("issuer_did");--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_type" ON "auth"."attestations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_auth_attestations_status" ON "auth"."attestations" USING btree ("attestation_status");--> statement-breakpoint
CREATE INDEX "idx_auth_challenges_expires" ON "auth"."challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_credentials_did" ON "auth"."credentials" USING btree ("did");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credentials_type_value" ON "auth"."credentials" USING btree ("type","value");--> statement-breakpoint
CREATE INDEX "idx_auth_identities_handle" ON "auth"."identities" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identity_chains_dfos_did" ON "auth"."identity_chains" USING btree ("dfos_did");--> statement-breakpoint
CREATE INDEX "idx_auth_onboard_tokens_token" ON "auth"."onboard_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_auth_onboard_tokens_email" ON "auth"."onboard_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_auth_tokens_identity" ON "auth"."tokens" USING btree ("identity_id");