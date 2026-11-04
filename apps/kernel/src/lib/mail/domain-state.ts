import { and, eq } from 'drizzle-orm';
import { attestations, db, mailDomains } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import type { MailDomainStatus } from './postal-contract';

export type MailDomainRow = typeof mailDomains.$inferSelect;
export type MailDomainTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function mailDomainStatus(row: MailDomainRow): MailDomainStatus {
  return {
    ownerDid: row.ownerDid, domain: row.domain, state: row.state,
    ownershipVerified: row.ownershipVerified, dnsOk: row.dnsOk,
    records: row.records, checkedAt: row.checkedAt?.toISOString() ?? null,
  };
}

/** Caller holds the domain's #2902 advisory lock. History is appended, never deleted. */
export async function writeMailDomain(tx: MailDomainTransaction, row: MailDomainRow): Promise<MailDomainStatus> {
  const evidence = await prepareMechanicalAttestation({
    subjectDid: row.ownerDid, type: 'mail.domain.changed',
    contextId: row.domain, contextType: 'mail.domain',
    payload: {
      ...mailDomainStatus(row), postalId: row.postalId,
      bindingAttestationId: row.bindingAttestationId, error: row.lastError,
      operationId: row.operationId,
      attempts: row.attempts, nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
    },
  });
  await tx.insert(attestations).values(evidence);
  await tx.insert(mailDomains).values(row).onConflictDoUpdate({
    target: [mailDomains.ownerDid, mailDomains.domain], set: row,
  });
  return mailDomainStatus(row);
}

/** Called inside the shared binding-revocation transaction, with its lock held. */
export async function disableMailDomain(tx: MailDomainTransaction, ownerDid: string, domain: string): Promise<void> {
  const [row] = await tx.select().from(mailDomains).where(and(
    eq(mailDomains.ownerDid, ownerDid), eq(mailDomains.domain, domain),
  )).limit(1);
  if (!row || row.state === 'disabled') return;
  await writeMailDomain(tx, {
    ...row, state: 'disabled', ownershipVerified: false, dnsOk: false,
    nextCheckAt: null, operationId: null, lastError: 'domain_revoked', updatedAt: new Date(),
  });
}
