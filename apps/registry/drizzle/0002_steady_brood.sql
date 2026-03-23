CREATE SCHEMA "relay";
--> statement-breakpoint
CREATE TABLE "relay"."relay_beacons" (
	"did" text PRIMARY KEY NOT NULL,
	"jws_token" text NOT NULL,
	"beacon_cid" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "relay"."relay_blobs" (
	"creator_did" text NOT NULL,
	"document_cid" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "relay_blobs_creator_did_document_cid_pk" PRIMARY KEY("creator_did","document_cid")
);
--> statement-breakpoint
CREATE TABLE "relay"."relay_content_chains" (
	"content_id" text PRIMARY KEY NOT NULL,
	"genesis_cid" text NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "relay"."relay_countersignatures" (
	"id" serial PRIMARY KEY NOT NULL,
	"operation_cid" text NOT NULL,
	"jws_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "relay"."relay_identity_chains" (
	"did" text PRIMARY KEY NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "relay"."relay_operations" (
	"cid" text PRIMARY KEY NOT NULL,
	"jws_token" text NOT NULL,
	"chain_type" text NOT NULL,
	"chain_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "registry"."nodes" ADD COLUMN "chain_did" text;--> statement-breakpoint
CREATE INDEX "idx_relay_countersignatures_operation_cid" ON "relay"."relay_countersignatures" USING btree ("operation_cid");--> statement-breakpoint
ALTER TABLE "registry"."nodes" ADD CONSTRAINT "nodes_chain_did_unique" UNIQUE("chain_did");