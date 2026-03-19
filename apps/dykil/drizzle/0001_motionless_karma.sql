ALTER TABLE "dykil"."survey_responses" DROP CONSTRAINT "survey_responses_survey_id_fkey";
--> statement-breakpoint
DROP INDEX "dykil"."idx_surveys_event";--> statement-breakpoint
DROP INDEX "dykil"."idx_survey_responses_respondent";--> statement-breakpoint
DROP INDEX "dykil"."idx_survey_responses_survey";--> statement-breakpoint
DROP INDEX "dykil"."idx_surveys_did";--> statement-breakpoint
DROP INDEX "dykil"."idx_surveys_status";--> statement-breakpoint
ALTER TABLE "dykil"."surveys" ALTER COLUMN "fields" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "dykil"."surveys" ALTER COLUMN "settings" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dykil"."surveys" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dykil"."survey_responses" ALTER COLUMN "answers" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "dykil"."survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "dykil"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_surveys_handle" ON "dykil"."surveys" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_responses_survey" ON "dykil"."survey_responses" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_responses_respondent" ON "dykil"."survey_responses" USING btree ("respondent_did");--> statement-breakpoint
CREATE INDEX "idx_responses_created" ON "dykil"."survey_responses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_surveys_did" ON "dykil"."surveys" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_surveys_status" ON "dykil"."surveys" USING btree ("status");--> statement-breakpoint
ALTER TABLE "dykil"."surveys" DROP COLUMN "event_id";--> statement-breakpoint
ALTER TABLE "dykil"."surveys" DROP COLUMN "required_for_tickets";