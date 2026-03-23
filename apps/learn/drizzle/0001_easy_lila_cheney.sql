DROP INDEX "learn"."idx_learn_lessons_module_id";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_courses_creator_did";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_courses_slug";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_enrollments_course_student";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_enrollments_student_did";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_modules_course_id";--> statement-breakpoint
CREATE INDEX "idx_learn_lessons_module_id" ON "learn"."lessons" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_learn_courses_creator_did" ON "learn"."courses" USING btree ("creator_did");--> statement-breakpoint
CREATE INDEX "idx_learn_courses_slug" ON "learn"."courses" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_learn_enrollments_course_student" ON "learn"."enrollments" USING btree ("course_id","student_did");--> statement-breakpoint
CREATE INDEX "idx_learn_enrollments_student_did" ON "learn"."enrollments" USING btree ("student_did");--> statement-breakpoint
CREATE INDEX "idx_learn_modules_course_id" ON "learn"."modules" USING btree ("course_id");