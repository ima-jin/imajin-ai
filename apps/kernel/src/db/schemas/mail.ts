import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { MailPurpose } from '@/src/lib/mail/types';
import type { MailDnsRecord, MailDomainStatus } from '@/src/lib/mail/postal-contract';

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

export const mailDomains = pgSchema('kernel').table('mail_domains', {
  ownerDid: text('owner_did').notNull(),
  domain: text('domain').notNull(),
  state: text('state').$type<MailDomainStatus['state']>().notNull().default('pending'),
  ownershipVerified: boolean('ownership_verified').notNull().default(false),
  dnsOk: boolean('dns_ok').notNull().default(false),
  records: jsonb('records').$type<MailDnsRecord[]>().notNull().default([]),
  postalId: text('postal_id'),
  operationId: text('operation_id'),
  bindingAttestationId: text('binding_attestation_id').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.ownerDid, table.domain] }),
  stateCheck: check('mail_domains_state_check', sql`${table.state} IN ('pending', 'verified', 'disabled')`),
  readyCheck: check('mail_domains_ready_check', sql`${table.state} <> 'verified' OR (${table.ownershipVerified} AND ${table.dnsOk})`),
  pendingIdx: index('idx_mail_domains_pending').on(table.nextCheckAt).where(sql`${table.state} = 'pending'`),
}));
