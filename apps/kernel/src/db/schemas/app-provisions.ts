import { pgSchema, text, timestamp, jsonb, index, boolean } from 'drizzle-orm/pg-core';

/**
 * `apps.provision` ledger (#2375, migration 0164_app_provisions.sql).
 *
 * One durable row per `slug` — not per attempt. This is both the
 * idempotency record ("re-run returns the existing repo/DID, does not
 * re-create") and the fail-closed record ("any step failing after repo
 * creation leaves a provision.failed record naming the step"). See
 * `apps/kernel/src/lib/apps/provision.ts` for the pipeline that reads and
 * writes it.
 *
 * Never holds secret material — only names/urls/booleans/timestamps.
 */
export const kernelAppProvisionsSchema = pgSchema('kernel');

export const appProvisions = kernelAppProvisionsSchema.table('app_provisions', {
  slug: text('slug').primaryKey(),
  appDid: text('app_did'),
  repoUrl: text('repo_url'),
  /** true when this run created the repo; false when an existing repo was found and reused. */
  repoCreated: boolean('repo_created'),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
  sealedAt: timestamp('sealed_at', { withTimezone: true }),
  /** Actions secret NAMES only — never values. */
  secretsSet: jsonb('secrets_set').$type<string[]>().notNull().default([]),
  /** Namespaced attestation types seeded at provision time, e.g. ['dykil/survey-response']. */
  attestationTypes: jsonb('attestation_types').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('pending'), // 'pending' | 'succeeded' | 'failed'
  failedStep: text('failed_step'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  statusIdx: index('idx_app_provisions_status').on(table.status),
}));

export type AppProvisionRow = typeof appProvisions.$inferSelect;
export type NewAppProvisionRow = typeof appProvisions.$inferInsert;

/** Literal union for app_provisions.status (#2375). */
export type AppProvisionStatus = 'pending' | 'succeeded' | 'failed';
