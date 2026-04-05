CREATE TABLE "relay"."relay_peer_cursors" (
	"peer_url" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
