CREATE SCHEMA "learn";
--> statement-breakpoint
CREATE TABLE "learn"."courses" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_did" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"slug" text,
	"price" integer DEFAULT 0,
	"currency" text DEFAULT 'CAD',
	"visibility" text DEFAULT 'public',
	"image_url" text,
	"image_asset_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"event_slug" text,
	"course_type" text DEFAULT 'course',
	"status" text DEFAULT 'draft',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "courses_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "learn"."enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"student_did" text NOT NULL,
	"payment_id" text,
	"enrolled_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "learn"."lesson_progress" (
	"enrollment_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"status" text DEFAULT 'not_started',
	"completed_at" timestamp with time zone,
	CONSTRAINT "lesson_progress_enrollment_id_lesson_id_pk" PRIMARY KEY("enrollment_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE "learn"."lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"title" text NOT NULL,
	"content_type" text DEFAULT 'markdown' NOT NULL,
	"content" text,
	"duration_minutes" integer,
	"sort_order" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "learn"."modules" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "learn"."enrollments" ADD CONSTRAINT "enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "learn"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" ADD CONSTRAINT "lesson_progress_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "learn"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "learn"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."lessons" ADD CONSTRAINT "lessons_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "learn"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn"."modules" ADD CONSTRAINT "modules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "learn"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learn_courses_creator_did" ON "learn"."courses" USING btree ("creator_did");--> statement-breakpoint
CREATE INDEX "idx_learn_courses_slug" ON "learn"."courses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_learn_enrollments_student_did" ON "learn"."enrollments" USING btree ("student_did");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_learn_enrollments_course_student" ON "learn"."enrollments" USING btree ("course_id","student_did");--> statement-breakpoint
CREATE INDEX "idx_learn_lessons_module_id" ON "learn"."lessons" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_learn_modules_course_id" ON "learn"."modules" USING btree ("course_id");