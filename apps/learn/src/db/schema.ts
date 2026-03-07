import { pgTable, text, timestamp, jsonb, integer, boolean, index, pgSchema, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';

export const learnSchema = pgSchema('learn');

/**
 * Courses — top-level learning containers
 */
export const courses = learnSchema.table('courses', {
  id: text('id').primaryKey(),                                    // crs_xxx
  creatorDid: text('creator_did').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  slug: text('slug').unique(),                                    // URL-friendly, learn.imajin.ai/{handle}/{slug}
  price: integer('price').default(0),                             // cents (0 = free)
  currency: text('currency').default('CAD'),
  visibility: text('visibility').default('public'),               // public / trust-bound / private
  imageUrl: text('image_url'),
  tags: jsonb('tags').default([]),
  metadata: jsonb('metadata').default({}),
  eventSlug: text('event_slug'),                                   // linked event on events.imajin.ai
  status: text('status').default('draft'),                        // draft / published / archived
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  creatorDidIdx: index('idx_learn_courses_creator_did').on(table.creatorDid),
  slugIdx: index('idx_learn_courses_slug').on(table.slug),
}));

/**
 * Modules — sections within a course
 */
export const modules = learnSchema.table('modules', {
  id: text('id').primaryKey(),                                    // mod_xxx
  courseId: text('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  courseIdIdx: index('idx_learn_modules_course_id').on(table.courseId),
}));

/**
 * Lessons — individual learning units within a module
 */
export const lessons = learnSchema.table('lessons', {
  id: text('id').primaryKey(),                                    // lsn_xxx
  moduleId: text('module_id').notNull().references(() => modules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  contentType: text('content_type').notNull().default('markdown'), // markdown / exercise / slide / video
  content: text('content'),                                       // Markdown body
  durationMinutes: integer('duration_minutes'),
  sortOrder: integer('sort_order').notNull(),
  metadata: jsonb('metadata').default({}),                        // Exercise instructions, video URL, etc.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  moduleIdIdx: index('idx_learn_lessons_module_id').on(table.moduleId),
}));

/**
 * Enrollments — student ↔ course relationship
 */
export const enrollments = learnSchema.table('enrollments', {
  id: text('id').primaryKey(),                                    // enr_xxx
  courseId: text('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  studentDid: text('student_did').notNull(),
  paymentId: text('payment_id'),                                  // nullable — free courses
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  studentDidIdx: index('idx_learn_enrollments_student_did').on(table.studentDid),
  courseStudentUnique: uniqueIndex('idx_learn_enrollments_course_student').on(table.courseId, table.studentDid),
}));

/**
 * Lesson Progress — per-lesson completion tracking
 */
export const lessonProgress = learnSchema.table('lesson_progress', {
  enrollmentId: text('enrollment_id').notNull().references(() => enrollments.id, { onDelete: 'cascade' }),
  lessonId: text('lesson_id').notNull().references(() => lessons.id, { onDelete: 'cascade' }),
  status: text('status').default('not_started'),                  // not_started / in_progress / completed
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ columns: [table.enrollmentId, table.lessonId] }),
}));
