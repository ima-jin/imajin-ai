-- Interest metadata — declared by apps during registration
CREATE TABLE "registry"."interests" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"triggers" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "interests_scope_unique" UNIQUE("scope")
);
--> statement-breakpoint
-- Global DID preferences
CREATE TABLE "registry"."did_preferences" (
	"did" text PRIMARY KEY NOT NULL,
	"global_marketing" boolean DEFAULT true,
	"auto_subscribe" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
-- Per-scope interests — created lazily from attestation activity
CREATE TABLE "registry"."did_interests" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"scope" text NOT NULL,
	"marketing" boolean DEFAULT true,
	"email" boolean DEFAULT true,
	"inapp" boolean DEFAULT true,
	"chat" boolean DEFAULT true,
	"created_by_attestation" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_did_interests_did_scope" UNIQUE("did","scope")
);
--> statement-breakpoint
CREATE INDEX "idx_did_interests_did" ON "registry"."did_interests" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_did_interests_scope" ON "registry"."did_interests" USING btree ("scope");--> statement-breakpoint
-- Seed interest records for existing apps
INSERT INTO "registry"."interests" ("id", "scope", "label", "description", "triggers") VALUES
  ('int_events000000001', 'events', 'Events & Gatherings', 'Updates about events you''ve attended or shown interest in', '["ticket.purchased","event.created","event.rsvp"]'::jsonb),
  ('int_market000000001', 'market', 'Marketplace', 'Updates about marketplace activity', '["listing.created","listing.purchased"]'::jsonb),
  ('int_coffee000000001', 'coffee', 'Tips & Support', 'Updates about tips and support pages', '["tip.received","tip.sent"]'::jsonb),
  ('int_connect00000001', 'connections', 'Connections', 'Updates about your network', '["connection.accepted","pod.created"]'::jsonb),
  ('int_chat0000000001', 'chat', 'Chat & Messaging', 'Chat notifications and mentions', '["chat.mention"]'::jsonb),
  ('int_learn000000001', 'learn', 'Learning', 'Course and learning updates', '["course.enrolled","module.completed"]'::jsonb)
ON CONFLICT ("scope") DO NOTHING;
