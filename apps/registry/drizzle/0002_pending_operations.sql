CREATE TABLE IF NOT EXISTS "relay"."relay_pending_operations" (
	"cid" text PRIMARY KEY NOT NULL,
	"jws_token" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now(),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"status" text DEFAULT 'pending' NOT NULL
);
