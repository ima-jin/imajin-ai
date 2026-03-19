ALTER TABLE "learn"."courses" DROP CONSTRAINT "courses_slug_key";--> statement-breakpoint
ALTER TABLE "learn"."modules" DROP CONSTRAINT "modules_course_id_fkey";
--> statement-breakpoint
ALTER TABLE "learn"."lessons" DROP CONSTRAINT "lessons_module_id_fkey";
--> statement-breakpoint
ALTER TABLE "learn"."enrollments" DROP CONSTRAINT "enrollments_course_id_fkey";
--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" DROP CONSTRAINT "lesson_progress_enrollment_id_fkey";
--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" DROP CONSTRAINT "lesson_progress_lesson_id_fkey";
--> statement-breakpoint
DROP INDEX "learn"."idx_learn_modules_course_id";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_lessons_module_id";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_enrollments_course_student";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_enrollments_student_did";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_courses_creator_did";--> statement-breakpoint
DROP INDEX "learn"."idx_learn_courses_slug";--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" DROP CONSTRAINT "lesson_progress_pkey";--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" ADD CONSTRAINT "lesson_progress_enrollment_id_lesson_id_pk" PRIMARY KEY("enrollment_id","lesson_id");--> statement-breakpoint
ALTER TABLE "learn"."modules" ADD CONSTRAINT "modules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "learn"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."lessons" ADD CONSTRAINT "lessons_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "learn"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."enrollments" ADD CONSTRAINT "enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "learn"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" ADD CONSTRAINT "lesson_progress_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "learn"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "learn"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learn_modules_course_id" ON "learn"."modules" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "idx_learn_lessons_module_id" ON "learn"."lessons" USING btree ("module_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_learn_enrollments_course_student" ON "learn"."enrollments" USING btree ("course_id","student_did");--> statement-breakpoint
CREATE INDEX "idx_learn_enrollments_student_did" ON "learn"."enrollments" USING btree ("student_did");--> statement-breakpoint
CREATE INDEX "idx_learn_courses_creator_did" ON "learn"."courses" USING btree ("creator_did");--> statement-breakpoint
CREATE INDEX "idx_learn_courses_slug" ON "learn"."courses" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "learn"."courses" ADD CONSTRAINT "courses_slug_unique" UNIQUE("slug");