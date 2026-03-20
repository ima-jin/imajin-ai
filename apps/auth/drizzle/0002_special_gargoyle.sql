CREATE TABLE "auth"."credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_credentials_did" ON "auth"."credentials" USING btree ("did");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credentials_type_value" ON "auth"."credentials" USING btree ("type","value");