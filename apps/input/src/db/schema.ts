import { pgSchema, text, timestamp, integer } from 'drizzle-orm/pg-core';

export const inputSchema = pgSchema('input');

/**
 * Jobs — processing queue for voice transcription and file uploads
 */
export const jobs = inputSchema.table('jobs', {
  id: text('id').primaryKey(),                          // job_xxx
  type: text('type').notNull(),                         // 'transcribe' | 'upload'
  status: text('status').notNull().default('pending'),  // 'pending' | 'processing' | 'done' | 'failed'
  requesterDid: text('requester_did').notNull(),        // DID of requesting identity
  inputRef: text('input_ref'),                          // path or URL to input file
  outputRef: text('output_ref'),                        // path or URL to output artifact
  durationSeconds: integer('duration_seconds'),         // media duration (audio/video)
  processingTimeMs: integer('processing_time_ms'),      // wall-clock processing time
  model: text('model'),                                 // model used (e.g. whisper-large-v3)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
