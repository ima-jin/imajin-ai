DROP INDEX "registry"."idx_registry_nodes_expires";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_nodes_hostname";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_nodes_status";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_builds_hash";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_builds_version";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_heartbeats_node";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_heartbeats_timestamp";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_trust_from";--> statement-breakpoint
DROP INDEX "registry"."idx_registry_trust_to";--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_expires" ON "registry"."nodes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_hostname" ON "registry"."nodes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "idx_registry_nodes_status" ON "registry"."nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_registry_builds_hash" ON "registry"."approved_builds" USING btree ("build_hash");--> statement-breakpoint
CREATE INDEX "idx_registry_builds_version" ON "registry"."approved_builds" USING btree ("version");--> statement-breakpoint
CREATE INDEX "idx_registry_heartbeats_node" ON "registry"."heartbeats" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_registry_heartbeats_timestamp" ON "registry"."heartbeats" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_registry_trust_from" ON "registry"."trust" USING btree ("from_node");--> statement-breakpoint
CREATE INDEX "idx_registry_trust_to" ON "registry"."trust" USING btree ("to_node");