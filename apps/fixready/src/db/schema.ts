import { pgTable, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Partner Companies (tenants)
export const partners = pgTable('partners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logoUrl: text('logo_url'),
  contactPhone: text('contact_phone'),
  contactEmail: text('contact_email').notNull(),
  responseWindowCopy: text('response_window_copy').default("We'll contact you within 24 hours"),
  webhookUrl: text('webhook_url'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Registration Tokens (for QR codes)
export const registrationTokens = pgTable('registration_tokens', {
  id: text('id').primaryKey(),
  partnerId: text('partner_id').references(() => partners.id).notNull(),
  label: text('label'),
  scans: integer('scans').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  expiresAt: timestamp('expires_at'),
});

// Appliances
export const appliances = pgTable('appliances', {
  id: text('id').primaryKey(),
  partnerId: text('partner_id').references(() => partners.id).notNull(),
  tokenId: text('token_id').references(() => registrationTokens.id),
  type: text('type').notNull(),
  brand: text('brand'),
  model: text('model'),
  serial: text('serial'),
  ageRange: text('age_range'),
  address: text('address').notNull(),
  unit: text('unit'),
  room: text('room'),
  contactPhone: text('contact_phone'),
  contactEmail: text('contact_email'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  partnerIdx: index('idx_appliances_partner').on(table.partnerId),
  tokenIdx: index('idx_appliances_token').on(table.tokenId),
}));

// Service Requests
export const serviceRequests = pgTable('service_requests', {
  id: text('id').primaryKey(),
  applianceId: text('appliance_id').references(() => appliances.id).notNull(),
  symptomCategory: text('symptom_category').notNull(),
  symptomDetails: jsonb('symptom_details').default({}),
  errorCode: text('error_code'),
  mediaUrls: text('media_urls').array(),
  confidence: text('confidence').default('medium'),
  suggestedCauses: text('suggested_causes').array(),
  suggestedParts: text('suggested_parts').array(),
  status: text('status').default('new'),
  assignedTo: text('assigned_to'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  applianceIdx: index('idx_requests_appliance').on(table.applianceId),
  statusIdx: index('idx_requests_status').on(table.status),
}));

// Jobs (for tech view)
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  requestId: text('request_id').references(() => serviceRequests.id).notNull(),
  techName: text('tech_name'),
  techPhone: text('tech_phone'),
  partsChecklist: text('parts_checklist').array(),
  accessNotes: text('access_notes'),
  postVisitFeedback: jsonb('post_visit_feedback'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  requestIdx: index('idx_jobs_request').on(table.requestId),
}));

// Relations
export const partnersRelations = relations(partners, ({ many }) => ({
  tokens: many(registrationTokens),
  appliances: many(appliances),
}));

export const registrationTokensRelations = relations(registrationTokens, ({ one }) => ({
  partner: one(partners, {
    fields: [registrationTokens.partnerId],
    references: [partners.id],
  }),
}));

export const appliancesRelations = relations(appliances, ({ one, many }) => ({
  partner: one(partners, {
    fields: [appliances.partnerId],
    references: [partners.id],
  }),
  requests: many(serviceRequests),
}));

export const serviceRequestsRelations = relations(serviceRequests, ({ one }) => ({
  appliance: one(appliances, {
    fields: [serviceRequests.applianceId],
    references: [appliances.id],
  }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  request: one(serviceRequests, {
    fields: [jobs.requestId],
    references: [serviceRequests.id],
  }),
}));

// Types
export type Partner = typeof partners.$inferSelect;
export type NewPartner = typeof partners.$inferInsert;
export type RegistrationToken = typeof registrationTokens.$inferSelect;
export type NewRegistrationToken = typeof registrationTokens.$inferInsert;
export type Appliance = typeof appliances.$inferSelect;
export type NewAppliance = typeof appliances.$inferInsert;
export type ServiceRequest = typeof serviceRequests.$inferSelect;
export type NewServiceRequest = typeof serviceRequests.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
