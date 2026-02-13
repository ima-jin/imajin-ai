import { pgTable, uuid, varchar, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';

export const groups = pgTable('dykil_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  createdByIp: varchar('created_by_ip', { length: 45 }),
});

export const submissions = pgTable('dykil_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  
  // Household info
  householdSize: integer('household_size').notNull(),
  postalCode: varchar('postal_code', { length: 20 }),
  
  // Optional email verification
  email: varchar('email', { length: 255 }),
  emailVerified: boolean('email_verified').default(false),
  verificationCode: varchar('verification_code', { length: 10 }),
  
  // Session tracking for quality scoring
  sessionIp: varchar('session_ip', { length: 45 }),
  sessionHeaders: jsonb('session_headers'),
  
  // Spending categories (dollars per month)
  streaming: integer('streaming').default(0),
  rideshare: integer('rideshare').default(0),
  cloud: integer('cloud').default(0),
  software: integer('software').default(0),
  memberships: integer('memberships').default(0),
  internet: integer('internet').default(0),
  utilities: integer('utilities').default(0),
  rent: integer('rent').default(0),
  other: integer('other').default(0),
});

export const submissionGroups = pgTable('dykil_submission_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'cascade' }).notNull(),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }).notNull(),
});

// Types
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type SubmissionGroup = typeof submissionGroups.$inferSelect;
