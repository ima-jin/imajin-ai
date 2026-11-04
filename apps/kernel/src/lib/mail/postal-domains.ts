import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { db, mailDomains } from '@/src/db';
import { normalizeDomain, resolveVerifiedDomain } from '@/src/lib/domains/service';
import { forEachSequential } from '@/src/lib/async/sequential';
import { MailDomainError, type MailDomainStatus, type PostalDomain } from './postal-contract';
import { requestPostalDomain } from './postal-admin';
import { mailDomainStatus, writeMailDomain, type MailDomainRow } from './domain-state';

export { mergeSpfInclude, publishableMailRecords } from './postal-contract';
export type { MailDnsRecord, MailDomainStatus } from './postal-contract';

function rowFor(ownerDid: string, domain: string) {
  return and(eq(mailDomains.ownerDid, ownerDid), eq(mailDomains.domain, domain));
}

async function storedRow(ownerDid: string, domain: string): Promise<MailDomainRow | undefined> {
  const [row] = await db.select().from(mailDomains).where(rowFor(ownerDid, domain)).limit(1);
  return row;
}

/** Stored state only: neither Postal nor DNS is consulted. */
export async function getMailDomainStatus(ownerDid: string, input: string): Promise<MailDomainStatus | null> {
  const row = await storedRow(ownerDid, normalizeDomain(input));
  return row ? mailDomainStatus(row) : null;
}

export async function listMailDomainStates(ownerDid: string): Promise<Array<MailDomainStatus & { error: string | null }>> {
  const rows = await db.select().from(mailDomains).where(eq(mailDomains.ownerDid, ownerDid)).orderBy(asc(mailDomains.domain));
  return rows.map(row => ({ ...mailDomainStatus(row), error: row.lastError }));
}

async function verifiedBinding(ownerDid: string, domain: string) {
  const binding = await resolveVerifiedDomain(domain);
  if (binding?.zoneOwner !== ownerDid) throw new MailDomainError('domain_not_verified', 403);
  return binding;
}

function nextCheck(attempts: number): Date {
  return new Date(Date.now() + Math.min(60_000 * 2 ** Math.min(attempts, 10), 24 * 60 * 60_000));
}

/** The HTTP request finishes BEFORE this transaction starts. Revoke/re-add invalidates old responses. */
function persistResult(
  ownerDid: string, domain: string, bindingId: string, postal: PostalDomain | null, error: string | null,
  operationId: string | null,
): Promise<MailDomainStatus> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${domain}, 2902))`);
    const binding = await resolveVerifiedDomain(domain, tx);
    const [previous] = await tx.select().from(mailDomains).where(rowFor(ownerDid, domain)).limit(1);
    // A later request or revocation owns this row now. An old response cannot overwrite it.
    if (previous && previous.operationId !== operationId) return mailDomainStatus(previous);
    const current = binding?.zoneOwner === ownerDid && String(binding.attestation?.id) === bindingId;
    const state = current ? postal?.state ?? 'pending' : 'disabled';
    const attempts = previous?.attempts ?? 1;
    return writeMailDomain(tx, {
      ownerDid, domain, state,
      ownershipVerified: current && (postal?.ownership_verified ?? false),
      dnsOk: current && (postal?.dns_ok ?? false),
      records: postal?.records ?? previous?.records ?? [],
      postalId: postal?.id ?? previous?.postalId ?? null,
      operationId: null,
      bindingAttestationId: current ? bindingId : previous?.bindingAttestationId ?? bindingId,
      checkedAt: postal?.dns_checked_at ? new Date(postal.dns_checked_at) : previous?.checkedAt ?? null,
      nextCheckAt: state === 'pending' ? nextCheck(attempts - 1) : null,
      attempts, lastError: current ? error : 'domain_revoked', updatedAt: new Date(),
    });
  });
}

function claimOperation(ownerDid: string, domain: string, bindingId: string, operation: 'create' | 'check') {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${domain}, 2902))`);
    const binding = await resolveVerifiedDomain(domain, tx);
    if (binding?.zoneOwner !== ownerDid || String(binding.attestation?.id) !== bindingId) {
      throw new MailDomainError('domain_not_verified', 403);
    }
    const [previous] = await tx.select().from(mailDomains).where(rowFor(ownerDid, domain)).limit(1);
    if (operation === 'check' && (!previous || previous.state === 'disabled' || previous.bindingAttestationId !== bindingId)) {
      throw new MailDomainError('mail_domain_not_provisioned', 409);
    }
    const operationId = randomUUID();
    const attempts = (previous?.attempts ?? 0) + 1;
    await writeMailDomain(tx, {
      ownerDid, domain, state: 'pending', ownershipVerified: false, dnsOk: false,
      records: previous?.records ?? [], postalId: previous?.postalId ?? null,
      operationId, bindingAttestationId: bindingId, checkedAt: previous?.checkedAt ?? null,
      attempts, nextCheckAt: nextCheck(attempts - 1), lastError: null, updatedAt: new Date(),
    });
    return { operationId, postalId: previous?.postalId };
  });
}
async function perform(ownerDid: string, input: string, operation: 'create' | 'check'): Promise<MailDomainStatus> {
  const domain = normalizeDomain(input);
  const binding = await verifiedBinding(ownerDid, domain);
  const bindingId = String(binding.attestation!.id);
  const claimed = await claimOperation(ownerDid, domain, bindingId, operation);
  let postal: PostalDomain;
  try {
    // A failed initial create is retried idempotently rather than checking a nonexistent Postal domain.
    postal = await requestPostalDomain(domain, claimed.postalId ? operation : 'create');
  } catch (error) {
    const failure = error instanceof MailDomainError ? error : new MailDomainError('postal_unavailable');
    await persistResult(ownerDid, domain, bindingId, null, failure.code, claimed.operationId);
    throw failure;
  }
  return persistResult(ownerDid, domain, bindingId, postal, null, claimed.operationId);
}

export function provisionMailDomain(ownerDid: string, domain: string): Promise<MailDomainStatus> {
  return perform(ownerDid, domain, 'create');
}

export function checkMailDomain(ownerDid: string, domain: string): Promise<MailDomainStatus> {
  return perform(ownerDid, domain, 'check');
}

/** Bounded cron batch, backoff on pending/errors; verified and disabled rows are never polled. */
export async function pollMailDomains(limit = 50): Promise<{ checked: number; failed: number }> {
  const rows = await db.select().from(mailDomains).where(and(
    eq(mailDomains.state, 'pending'), lte(mailDomains.nextCheckAt, new Date()),
  )).orderBy(asc(mailDomains.nextCheckAt)).limit(Math.max(1, Math.min(limit, 100)));
  const result = { checked: 0, failed: 0 };
  await forEachSequential(rows, async row => {
    try {
      await checkMailDomain(row.ownerDid, row.domain);
      result.checked++;
    } catch (error) {
      // Ownership expiry/revocation is not a Postal error, but still needs a durable disabled state.
      if (error instanceof MailDomainError && error.code === 'domain_not_verified') {
        await persistResult(row.ownerDid, row.domain, row.bindingAttestationId, null, 'domain_revoked', row.operationId);
      }
      result.failed++;
    }
  });
  return result;
}
