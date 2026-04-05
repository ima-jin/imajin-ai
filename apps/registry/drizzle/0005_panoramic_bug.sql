CREATE TABLE "relay"."relay_config" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"did" text NOT NULL,
	"profile_artifact_jws" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
