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
ALTER TABLE "auth"."identity_chains" ADD CONSTRAINT "identity_chains_did_identities_id_fk" FOREIGN KEY ("did") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identity_chains_dfos_did" ON "auth"."identity_chains" USING btree ("dfos_did");