CREATE TABLE "auth"."devices" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"fingerprint" text NOT NULL,
	"name" text,
	"ip" text,
	"user_agent" text,
	"trusted" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "auth"."mfa_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"type" text NOT NULL,
	"secret" text NOT NULL,
	"name" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."stored_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"salt" text NOT NULL,
	"key_derivation" text DEFAULT 'pbkdf2' NOT NULL,
	"device_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth"."devices" ADD CONSTRAINT "devices_did_identities_id_fk" FOREIGN KEY ("did") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."mfa_methods" ADD CONSTRAINT "mfa_methods_did_identities_id_fk" FOREIGN KEY ("did") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."stored_keys" ADD CONSTRAINT "stored_keys_did_identities_id_fk" FOREIGN KEY ("did") REFERENCES "auth"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_devices_did_fingerprint" ON "auth"."devices" USING btree ("did","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_devices_did" ON "auth"."devices" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_mfa_methods_did" ON "auth"."mfa_methods" USING btree ("did");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_stored_keys_did" ON "auth"."stored_keys" USING btree ("did");