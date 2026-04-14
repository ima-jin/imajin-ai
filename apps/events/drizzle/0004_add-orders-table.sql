CREATE TABLE "events"."orders" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_session_id" text NOT NULL,
	"event_id" text NOT NULL,
	"ticket_type_id" text NOT NULL,
	"buyer_did" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_total" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"payment_method" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "orders_stripe_session_id_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
ALTER TABLE "events"."tickets" ADD COLUMN IF NOT EXISTS "stripe_session_id" text;
--> statement-breakpoint
ALTER TABLE "events"."orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events"."orders" ADD CONSTRAINT "orders_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "events"."ticket_types"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_orders_event" ON "events"."orders" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "idx_orders_buyer" ON "events"."orders" USING btree ("buyer_did");
--> statement-breakpoint
CREATE INDEX "idx_orders_stripe_session" ON "events"."orders" USING btree ("stripe_session_id");
--> statement-breakpoint
CREATE INDEX "idx_tickets_stripe_session" ON "events"."tickets" USING btree ("stripe_session_id");
