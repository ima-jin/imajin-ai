ALTER TABLE "events"."event_invites" DROP CONSTRAINT "event_invites_token_key";--> statement-breakpoint
ALTER TABLE "events"."tickets" DROP CONSTRAINT "tickets_magic_token_key";--> statement-breakpoint
ALTER TABLE "events"."event_invites" DROP CONSTRAINT "event_invites_event_id_fkey";
--> statement-breakpoint
ALTER TABLE "events"."ticket_registrations" DROP CONSTRAINT "ticket_registrations_ticket_id_fkey";
--> statement-breakpoint
ALTER TABLE "events"."ticket_registrations" DROP CONSTRAINT "ticket_registrations_event_id_fkey";
--> statement-breakpoint
DROP INDEX "events"."idx_events_course_slug";--> statement-breakpoint
DROP INDEX "events"."idx_events_creator";--> statement-breakpoint
DROP INDEX "events"."idx_events_pod_id";--> statement-breakpoint
DROP INDEX "events"."idx_events_starts";--> statement-breakpoint
DROP INDEX "events"."idx_events_status";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_queue_did";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_queue_position";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_queue_status";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_queue_type";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_transfers_from";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_transfers_ticket";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_transfers_to";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_types_event";--> statement-breakpoint
DROP INDEX "events"."idx_tickets_event";--> statement-breakpoint
DROP INDEX "events"."idx_tickets_held_by";--> statement-breakpoint
DROP INDEX "events"."idx_tickets_owner";--> statement-breakpoint
DROP INDEX "events"."idx_tickets_registration_status";--> statement-breakpoint
DROP INDEX "events"."idx_tickets_status";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_registrations_email";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_registrations_event";--> statement-breakpoint
DROP INDEX "events"."idx_ticket_registrations_ticket";--> statement-breakpoint
DROP INDEX "events"."idx_event_admins_did";--> statement-breakpoint
DROP INDEX "events"."idx_event_admins_event";--> statement-breakpoint
ALTER TABLE "events"."tickets" ALTER COLUMN "payment_method" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "events"."event_invites" ADD CONSTRAINT "event_invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."ticket_registrations" ADD CONSTRAINT "ticket_registrations_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "events"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."ticket_registrations" ADD CONSTRAINT "ticket_registrations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tickets_magic_token" ON "events"."tickets" USING btree ("magic_token");--> statement-breakpoint
CREATE INDEX "idx_events_course_slug" ON "events"."events" USING btree ("course_slug");--> statement-breakpoint
CREATE INDEX "idx_events_creator" ON "events"."events" USING btree ("creator_did");--> statement-breakpoint
CREATE INDEX "idx_events_pod_id" ON "events"."events" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "idx_events_starts" ON "events"."events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "idx_events_status" ON "events"."events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_did" ON "events"."ticket_queue" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_position" ON "events"."ticket_queue" USING btree ("position");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_status" ON "events"."ticket_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_type" ON "events"."ticket_queue" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_transfers_from" ON "events"."ticket_transfers" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_ticket_transfers_ticket" ON "events"."ticket_transfers" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_transfers_to" ON "events"."ticket_transfers" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_ticket_types_event" ON "events"."ticket_types" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_event" ON "events"."tickets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_held_by" ON "events"."tickets" USING btree ("held_by");--> statement-breakpoint
CREATE INDEX "idx_tickets_owner" ON "events"."tickets" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "idx_tickets_registration_status" ON "events"."tickets" USING btree ("registration_status");--> statement-breakpoint
CREATE INDEX "idx_tickets_status" ON "events"."tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ticket_registrations_email" ON "events"."ticket_registrations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_ticket_registrations_event" ON "events"."ticket_registrations" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_registrations_ticket" ON "events"."ticket_registrations" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_event_admins_did" ON "events"."event_admins" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_event_admins_event" ON "events"."event_admins" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "events"."event_invites" ADD CONSTRAINT "event_invites_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "events"."tickets" ADD CONSTRAINT "tickets_magic_token_unique" UNIQUE("magic_token");