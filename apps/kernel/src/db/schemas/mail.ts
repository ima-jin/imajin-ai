import { sql } from 'drizzle-orm';
import { check, pgSchema, primaryKey, text } from 'drizzle-orm/pg-core';
import type { MailPurpose } from '@/src/lib/mail/types';

export const mailSenders = pgSchema('kernel').table('mail_senders', {
  ownerDid: text('owner_did').notNull(),
  purpose: text('purpose').$type<MailPurpose>().notNull(),
  appDid: text('app_did').notNull().default(''),
  domain: text('domain').notNull(),
  localPart: text('local_part').notNull(),
  displayName: text('display_name').notNull(),
  replyTo: text('reply_to'),
}, table => ({
  pk: primaryKey({ columns: [table.ownerDid, table.purpose, table.appDid] }),
  purposeCheck: check('mail_senders_purpose_check', sql`${table.purpose} IN ('signin', 'receipts', 'notifications', 'contact')`),
}));
