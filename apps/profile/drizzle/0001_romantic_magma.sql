DROP INDEX "profile"."idx_conn_requests_from";--> statement-breakpoint
DROP INDEX "profile"."idx_conn_requests_status";--> statement-breakpoint
DROP INDEX "profile"."idx_conn_requests_to";--> statement-breakpoint
DROP INDEX "profile"."idx_connections_from";--> statement-breakpoint
DROP INDEX "profile"."idx_connections_source";--> statement-breakpoint
DROP INDEX "profile"."idx_connections_to";--> statement-breakpoint
DROP INDEX "profile"."idx_follows_followed";--> statement-breakpoint
DROP INDEX "profile"."idx_follows_follower";--> statement-breakpoint
DROP INDEX "profile"."idx_follows_unique";--> statement-breakpoint
DROP INDEX "profile"."idx_profiles_display_type";--> statement-breakpoint
DROP INDEX "profile"."idx_profiles_handle";--> statement-breakpoint
DROP INDEX "profile"."idx_did_migrations_new";--> statement-breakpoint
DROP INDEX "profile"."idx_did_migrations_old";--> statement-breakpoint
DROP INDEX "profile"."idx_query_logs_requester";--> statement-breakpoint
DROP INDEX "profile"."idx_query_logs_target";--> statement-breakpoint
CREATE INDEX "idx_conn_requests_from" ON "profile"."connection_requests" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_conn_requests_status" ON "profile"."connection_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_conn_requests_to" ON "profile"."connection_requests" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_connections_from" ON "profile"."connections" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_connections_source" ON "profile"."connections" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "idx_connections_to" ON "profile"."connections" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_follows_followed" ON "profile"."follows" USING btree ("followed_did");--> statement-breakpoint
CREATE INDEX "idx_follows_follower" ON "profile"."follows" USING btree ("follower_did");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_follows_unique" ON "profile"."follows" USING btree ("follower_did","followed_did");--> statement-breakpoint
CREATE INDEX "idx_profiles_display_type" ON "profile"."profiles" USING btree ("display_type");--> statement-breakpoint
CREATE INDEX "idx_profiles_handle" ON "profile"."profiles" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_did_migrations_new" ON "profile"."did_migrations" USING btree ("new_did");--> statement-breakpoint
CREATE INDEX "idx_did_migrations_old" ON "profile"."did_migrations" USING btree ("old_did");--> statement-breakpoint
CREATE INDEX "idx_query_logs_requester" ON "profile"."query_logs" USING btree ("requester_did");--> statement-breakpoint
CREATE INDEX "idx_query_logs_target" ON "profile"."query_logs" USING btree ("target_did");