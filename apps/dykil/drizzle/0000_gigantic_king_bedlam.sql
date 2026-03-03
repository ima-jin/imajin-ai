CREATE TABLE "survey_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"respondent_did" text,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text,
	"title" text NOT NULL,
	"description" text,
	"fields" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"event_id" text,
	"type" text DEFAULT 'survey' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_responses_survey" ON "survey_responses" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_responses_respondent" ON "survey_responses" USING btree ("respondent_did");--> statement-breakpoint
CREATE INDEX "idx_responses_created" ON "survey_responses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_surveys_did" ON "surveys" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_surveys_handle" ON "surveys" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_surveys_status" ON "surveys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_surveys_event" ON "surveys" USING btree ("event_id");