import { index, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { SignedReachReplyEvent } from '@/src/lib/auth/reach-reply-wire';

const reachSchema = pgSchema('auth');

/** Private delivery content; foreign principal claims are recorded, never verified. */
export interface ReachEnvelope {
  reachId: string;
  principalDid: string;
  requesterDid: string;
  onBehalfOfStubDid: string;
  onBehalfOf: { platform: string; externalRef: string; selfDescription?: string };
  claimVerified: false;
  topic: string;
  message: string;
  replyHandle: string;
  transcriptHash: string;
  requesterSignature: string;
  requesterTier: string;
  requesterAuthTier?: 'signed' | 'oauth' | 'bearer';
  /** Null for a tier-admitted caller authorized by the principal's gate. */
  grantId: string | null;
  /** Delivery server timestamp, distinct from the caller-signed timestamp. */
  issuedAt: string;
  requestIssuedAt: string;
  signedEvent: Record<string, unknown>;
  /** Immutable principal-signed reply; never signed by the node or a delegate. */
  reply?: SignedReachReplyEvent;
  /** Bus acknowledgement is separate so pending signed replies can be replayed. */
  replyPublishedAt?: string;
}

export const reachEnvelopes = reachSchema.table('reach_envelopes', {
  reachId: text('reach_id').primaryKey(),
  principalDid: text('principal_did').notNull(),
  requesterDid: text('requester_did').notNull(),
  transcriptHash: text('transcript_hash').notNull(),
  envelope: jsonb('envelope').$type<ReachEnvelope>().notNull(),
  // Database time, not either supplied timestamp, is authoritative for caps.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => ({
  replayIdx: uniqueIndex('idx_reach_envelopes_replay').on(table.principalDid, table.requesterDid, table.transcriptHash),
  principalDayIdx: index('idx_reach_envelopes_principal_day').on(table.principalDid, table.createdAt),
  senderDayIdx: index('idx_reach_envelopes_sender_day').on(table.principalDid, table.requesterDid, table.createdAt),
}));

/** Principal-owned sender blocks; intentionally no UI, callbacks, or reply workflow. */
export const reachSenderBlocks = reachSchema.table('reach_sender_blocks', {
  principalDid: text('principal_did').notNull(),
  requesterDid: text('requester_did').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.principalDid, table.requesterDid] }),
}));
