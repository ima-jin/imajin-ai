CREATE SCHEMA "registry";
--> statement-breakpoint
CREATE SCHEMA "relay";
--> statement-breakpoint
CREATE TABLE "registry"."approved_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"build_hash" text NOT NULL,
	"architecture" text,
	"release_date" timestamp with time zone DEFAULT now(),
	"deprecated" boolean DEFAULT false,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "approved_builds_build_hash_unique" UNIQUE("build_hash")
);
--> statement-breakpoint
CREATE TABLE "registry"."heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now(),
	"build_hash" text NOT NULL,
	"version" text NOT NULL,
	"health" jsonb,
	"signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry"."nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"hostname" text NOT NULL,
	"subdomain" text NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb,
	"capabilities" jsonb DEFAULT '[]'::jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"build_hash" text NOT NULL,
	"version" text NOT NULL,
	"source_commit" text,
	"last_heartbeat" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now(),
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"chain_did" text,
	"attestation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "nodes_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "nodes_hostname_unique" UNIQUE("hostname"),
	CONSTRAINT "nodes_subdomain_unique" UNIQUE("subdomain"),
	CONSTRAINT "nodes_chain_did_unique" UNIQUE("chain_did")
);
--> statement-breakpoint
CREATE TABLE "registry"."trust" (
	"id" text PRIMARY KEY NOT NULL,
	"from_node" text NOT NULL,
	"to_node" text NOT NULL,
	"established_at" timestamp with time zone NOT NULL,
	"verification_method" text NOT NULL,
	"strength" text NOT NULL,
	"last_verified" timestamp with time zone,
	"from_signature" text NOT NULL,
	"to_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
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
ALTER TABLE "registry"."heartbeats" ADD CONSTRAINT "heartbeats_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "registry"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry"."trust" ADD CONSTRAINT "trust_from_node_nodes_id_fk" FOREIGN KEY ("from_node") REFERENCES "registry"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry"."trust" ADD CONSTRAINT "trust_to_node_nodes_id_fk" FOREIGN KEY ("to_node") REFERENCES "registry"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_registry_builds_version" ON "registry"."approved_builds" USING btree ("version");--> statement-breakpoint
CREATE INDEX "idx_registry_builds_hash" ON "registry"."approved_builds" USING btree ("build_hash");--> statement-breakpoint
CREATE INDEX "idx_registry_heartbeats_node" ON "registry"."heartbeats" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_registry_heartbeats_timestamp" ON "registry"."heartbeats" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_status" ON "registry"."nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_expires" ON "registry"."nodes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_hostname" ON "registry"."nodes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "idx_registry_trust_from" ON "registry"."trust" USING btree ("from_node");--> statement-breakpoint
CREATE INDEX "idx_registry_trust_to" ON "registry"."trust" USING btree ("to_node");--> statement-breakpoint
CREATE INDEX "idx_relay_countersignatures_operation_cid" ON "relay"."relay_countersignatures" USING btree ("operation_cid");