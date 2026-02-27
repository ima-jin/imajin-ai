import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Surveys - form definitions
 */
export const surveys = pgTable('surveys', {
  id: text('id').primaryKey(),                                // survey_xxx
  did: text('did').notNull(),                                 // Owner DID
  title: text('title').notNull(),
  description: text('description'),
  fields: jsonb('fields').notNull(),                          // Form field definitions
  settings: jsonb('settings').default({}),                    // Survey settings
  eventId: text('event_id'),                                  // Optional event link
  status: text('status').notNull().default('draft'),          // draft, published, closed
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_surveys_did').on(table.did),
  statusIdx: index('idx_surveys_status').on(table.status),
  eventIdx: index('idx_surveys_event').on(table.eventId),
}));

/**
 * Survey Responses - submitted answers
 */
export const surveyResponses = pgTable('survey_responses', {
  id: text('id').primaryKey(),                                // response_xxx
  surveyId: text('survey_id').references(() => surveys.id, { onDelete: 'cascade' }).notNull(),
  respondentDid: text('respondent_did'),                      // null for anonymous
  answers: jsonb('answers').notNull(),                        // { fieldId: value }
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  surveyIdx: index('idx_responses_survey').on(table.surveyId),
  respondentIdx: index('idx_responses_respondent').on(table.respondentDid),
  createdIdx: index('idx_responses_created').on(table.createdAt),
}));

// Types
export type Survey = typeof surveys.$inferSelect;
export type NewSurvey = typeof surveys.$inferInsert;
export type SurveyResponse = typeof surveyResponses.$inferSelect;
export type NewSurveyResponse = typeof surveyResponses.$inferInsert;

// Field Types
export type FieldType = 'text' | 'textarea' | 'select' | 'rating' | 'boolean' | 'number';

export interface FieldDefinition {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: string[];           // For select fields
  multiple?: boolean;           // For select fields
  min?: number;                 // For rating/number fields
  max?: number;                 // For rating/number fields
}

export interface SurveySettings {
  allowAnonymous?: boolean;
  requireAuth?: boolean;
  multipleResponses?: boolean;
  showResults?: boolean;
}
