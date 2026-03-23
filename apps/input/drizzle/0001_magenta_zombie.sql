CREATE TABLE "input"."jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requester_did" text NOT NULL,
	"input_ref" text,
	"output_ref" text,
	"duration_seconds" integer,
	"processing_time_ms" integer,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now()
);
