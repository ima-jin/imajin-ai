ALTER TABLE "registry"."nodes" DROP CONSTRAINT "registry_nodes_public_key_unique";--> statement-breakpoint
ALTER TABLE "registry"."nodes" DROP CONSTRAINT "registry_nodes_hostname_unique";--> statement-breakpoint
ALTER TABLE "registry"."nodes" DROP CONSTRAINT "registry_nodes_subdomain_unique";--> statement-breakpoint
ALTER TABLE "registry"."approved_builds" DROP CONSTRAINT "registry_approved_builds_build_hash_unique";--> statement-breakpoint
ALTER TABLE "registry"."heartbeats" DROP CONSTRAINT "registry_heartbeats_node_id_registry_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "registry"."trust" DROP CONSTRAINT "registry_trust_from_node_registry_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "registry"."trust" DROP CONSTRAINT "registry_trust_to_node_registry_nodes_id_fk";
--> statement-breakpoint
DROP INDEX "registry"."idx_registry_nodes_expires";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_nodes_hostname";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_nodes_status";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_builds_hash";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_builds_version";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_heartbeats_node";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_heartbeats_timestamp";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_trust_from";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_trust_to";--> statement-breakpoint
ALTER TABLE "registry"."heartbeats" ADD CONSTRAINT "heartbeats_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "registry"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry"."trust" ADD CONSTRAINT "trust_from_node_nodes_id_fk" FOREIGN KEY ("from_node") REFERENCES "registry"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry"."trust" ADD CONSTRAINT "trust_to_node_nodes_id_fk" FOREIGN KEY ("to_node") REFERENCES "registry"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_expires" ON "registry"."nodes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_hostname" ON "registry"."nodes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_status" ON "registry"."nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_registry_builds_hash" ON "registry"."approved_builds" USING btree ("build_hash");--> statement-breakpoint
CREATE INDEX "idx_registry_builds_version" ON "registry"."approved_builds" USING btree ("version");--> statement-breakpoint
CREATE INDEX "idx_registry_heartbeats_node" ON "registry"."heartbeats" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_registry_heartbeats_timestamp" ON "registry"."heartbeats" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_registry_trust_from" ON "registry"."trust" USING btree ("from_node");--> statement-breakpoint
CREATE INDEX "idx_registry_trust_to" ON "registry"."trust" USING btree ("to_node");--> statement-breakpoint
ALTER TABLE "registry"."nodes" ADD CONSTRAINT "nodes_public_key_unique" UNIQUE("public_key");--> statement-breakpoint
ALTER TABLE "registry"."nodes" ADD CONSTRAINT "nodes_hostname_unique" UNIQUE("hostname");--> statement-breakpoint
ALTER TABLE "registry"."nodes" ADD CONSTRAINT "nodes_subdomain_unique" UNIQUE("subdomain");--> statement-breakpoint
ALTER TABLE "registry"."approved_builds" ADD CONSTRAINT "approved_builds_build_hash_unique" UNIQUE("build_hash");