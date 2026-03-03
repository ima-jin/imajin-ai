import { pgTable, text, timestamp, jsonb, index, pgSchema } from 'drizzle-orm/pg-core';

export const dykil_schema = pgSchema('dykil');

/**
 * Surveys - form definitions
 */
export const surveys = dykil_schema.table('surveys', {
  id: text('id').primaryKey(),                                // survey_xxx
  did: text('did').notNull(),                                 // Owner DID
  handle: text('handle'),                                     // Creator's handle for URL routing
  title: text('title').notNull(),
  description: text('description'),
  fields: jsonb('fields').notNull(),                          // SurveyJS JSON schema (elements array)
  settings: jsonb('settings').default({}),                    // Survey settings
  eventId: text('event_id'),                                  // Optional event link
  type: text('type').notNull().default('survey'),             // survey, pre-event, post-event, form
  status: text('status').notNull().default('draft'),          // draft, published, closed
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_surveys_did').on(table.did),
  handleIdx: index('idx_surveys_handle').on(table.handle),
  statusIdx: index('idx_surveys_status').on(table.status),
  eventIdx: index('idx_surveys_event').on(table.eventId),
}));

/**
 * Survey Responses - submitted answers
 */
export const surveyResponses = dykil_schema.table('survey_responses', {
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

// SurveyJS Types
export type SurveyType = 'survey' | 'pre-event' | 'post-event' | 'form';

// SurveyJS element types
export type SurveyJSElementType =
  | 'text'           // Single-line text input
  | 'comment'        // Multi-line textarea
  | 'radiogroup'     // Radio button group
  | 'checkbox'       // Checkbox group
  | 'dropdown'       // Dropdown select
  | 'rating'         // Rating scale
  | 'boolean'        // Yes/No toggle
  | 'number'         // Number input
  | 'email';         // Email input

// SurveyJS element definition (compatible with survey-core)
export interface SurveyJSElement {
  type: SurveyJSElementType | string;
  name: string;              // Unique field identifier
  title: string;             // Display label
  isRequired?: boolean;
  choices?: Array<string | { value: string; text: string }>;  // For select types
  rateMin?: number;          // For rating type
  rateMax?: number;          // For rating type
  min?: number;              // For number type
  max?: number;              // For number type
  inputType?: string;        // For text type: 'text', 'email', 'number'
  [key: string]: any;        // Allow other SurveyJS properties
}

// SurveyJS JSON structure
export interface SurveyJSSchema {
  elements?: SurveyJSElement[];
  pages?: Array<{
    name: string;
    elements: SurveyJSElement[];
  }>;
  [key: string]: any;  // Allow other SurveyJS properties
}

export interface SurveySettings {
  allowAnonymous?: boolean;
  requireAuth?: boolean;
  multipleResponses?: boolean;
  showResults?: boolean;
}
