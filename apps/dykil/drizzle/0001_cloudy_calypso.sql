DROP INDEX "dykil"."idx_surveys_event";--> statement-breakpoint
DROP INDEX "dykil"."idx_surveys_did";--> statement-breakpoint
DROP INDEX "dykil"."idx_surveys_handle";--> statement-breakpoint
DROP INDEX "dykil"."idx_surveys_status";--> statement-breakpoint
DROP INDEX "dykil"."idx_responses_created";--> statement-breakpoint
DROP INDEX "dykil"."idx_responses_respondent";--> statement-breakpoint
DROP INDEX "dykil"."idx_responses_survey";--> statement-breakpoint
CREATE INDEX "idx_surveys_did" ON "dykil"."surveys" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_surveys_handle" ON "dykil"."surveys" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_surveys_status" ON "dykil"."surveys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_responses_created" ON "dykil"."survey_responses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_responses_respondent" ON "dykil"."survey_responses" USING btree ("respondent_did");--> statement-breakpoint
CREATE INDEX "idx_responses_survey" ON "dykil"."survey_responses" USING btree ("survey_id");--> statement-breakpoint
ALTER TABLE "dykil"."surveys" DROP COLUMN "event_id";--> statement-breakpoint
ALTER TABLE "dykil"."surveys" DROP COLUMN "required_for_tickets";