import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, attestations, domainBindings, identities, nodes, registryApps, type DomainBindingRow } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { domainSigningIdentity, getImajinOrganization } from './signing';
import { DomainError, isImajinDomain, normalizeDomain } from './normalize';
import { forEachSequential } from '@/src/lib/async/sequential';

export { DomainError, normalizeDomain } from './normalize';
export type DomainBinding = Pick<DomainBindingRow,
  'domain' | 'zoneOwner' | 'siteOwner' | 'appDid' | 'method' | 'status' | 'attestation' | 'verifiedAt' | 'checkedAt'>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const log = createLogger('kernel:domains');
const resolver = new Resolver({ timeout: 3000, tries: 1 });
const RESERVED_LABELS = new Set([
  'auth', 'pay', 'profile', 'chat', 'media', 'notify', 'registry', 'connections',
  'www', 'jin', 'dev-jin', 'dev', 'api', 'admin', 'relay', 'vault', 'mail', 'smtp', 'ns1', 'ns2',
]);
const APP_DOMAIN_AUTHORITY = {
  ownerDid: registryApps.ownerDid,
  entryUrl: registryApps.entryUrl,
  callbackUrl: registryApps.callbackUrl,
  homepageUrl: registryApps.homepageUrl,
};
type AppDomainAuthority = Pick<typeof registryApps.$inferSelect, 'ownerDid' | 'entryUrl' | 'callbackUrl' | 'homepageUrl'>;

/**
 * DNS control alone cannot attribute an attacker's site to a victim app.
 * Cross-owner custom hosts must already be advertised by the authoritative app
 * registry; trusted organization issuance is its own on-record authorization.
 */
function appAuthorizesDomain(app: AppDomainAuthority, domain: string, zoneOwner: string, organizationIssued: boolean): boolean {
  if (organizationIssued || app.ownerDid === zoneOwner) return true;
  return [app.entryUrl, app.callbackUrl, app.homepageUrl].some((value) => {
    if (!value) return false;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && normalizeDomain(url.hostname) === domain;
    } catch { return false; }
  });
}

function binding(row: DomainBindingRow): DomainBinding {
  const { domain, zoneOwner, siteOwner, appDid, method, status, attestation, verifiedAt, checkedAt } = row;
  return { domain, zoneOwner, siteOwner, appDid, method, status, attestation, verifiedAt, checkedAt };
}
async function hasCurrentSiteOwner(row: DomainBindingRow): Promise<boolean> {
  // Cron checks after 24h; reads expire DNS evidence at 48h even if cron stops.
  if (row.method === 'dns-txt' && (!row.checkedAt || row.checkedAt.getTime() < Date.now() - 48 * 60 * 60 * 1000)) return false;
  if (!row.appDid) return true;
  const [app] = await db.select(APP_DOMAIN_AUTHORITY).from(registryApps).where(and(
    eq(registryApps.appDid, row.appDid), eq(registryApps.status, 'active'), eq(registryApps.ownerDid, row.siteOwner),
  )).limit(1);
  return Boolean(app && appAuthorizesDomain(app, row.domain, row.zoneOwner, row.method === 'imajin-issued'));
}

/** Every mutation serializes by domain, including nonexistent/pending claims. */
async function lockDomain(tx: Transaction, domain: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${domain}, 2902))`);
}

async function resolveSiteOwner(tx: Transaction, zoneOwner: string, domain: string, appDid?: string | null, organizationIssued = false): Promise<string> {
  const [zone] = await tx.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.id, zoneOwner), isNull(identities.suspendedAt))).limit(1);
  if (!zone) throw new DomainError('identity_not_found', 'Zone owner identity not found', 404);
  if (!appDid) return zoneOwner;
  const [app] = await tx.select(APP_DOMAIN_AUTHORITY).from(registryApps)
    .where(and(eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'))).limit(1).for('share');
  if (!app) throw new DomainError('app_not_found', 'Active registered app not found', 404);
  // App ownership is authoritative registry data, never arbitrary request data.
  const [owner] = await tx.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.id, app.ownerDid), isNull(identities.suspendedAt))).limit(1);
  if (!owner) throw new DomainError('app_owner_unavailable', 'Registered app owner is unavailable', 409);
  if (!appAuthorizesDomain(app, domain, zoneOwner, organizationIssued)) {
    throw new DomainError('app_domain_not_authorized', 'The app owner must register this domain in its app URLs before it can be bound', 403);
  }
  return app.ownerDid;
}

async function claim(tx: Transaction, domain: string, zoneOwner: string): Promise<DomainBindingRow | undefined> {
  const [row] = await tx.select().from(domainBindings)
    .where(and(eq(domainBindings.domain, domain), eq(domainBindings.zoneOwner, zoneOwner))).limit(1);
  return row;
}

async function assertNoVerifiedCompetitor(tx: Transaction, domain: string, zoneOwner: string): Promise<void> {
  const rows = await tx.select().from(domainBindings).where(and(
    eq(domainBindings.domain, domain), eq(domainBindings.status, 'verified'),
  ));
  if (rows.some((row) => row.zoneOwner !== zoneOwner)) {
    throw new DomainError('domain_conflict', 'Domain already has an active binding', 409);
  }
}

/** Internal service: callers MUST enforce owner/admin auth and delegation policy. */
export async function addDomain(input: { domain: string; zoneOwner: string; appDid?: string | null }): Promise<DomainBinding> {
  const domain = normalizeDomain(input.domain);
  if (isImajinDomain(domain)) throw new DomainError('reserved_domain', 'Imajin domains require organization issuance', 403);
  return await db.transaction(async (tx) => {
    await lockDomain(tx, domain);
    await assertNoVerifiedCompetitor(tx, domain, input.zoneOwner);
    const siteOwner = await resolveSiteOwner(tx, input.zoneOwner, domain, input.appDid);
    const existing = await claim(tx, domain, input.zoneOwner);
    if (existing?.status === 'legacy') return binding(existing);
    if (existing?.status === 'verified') {
      if (existing.appDid !== (input.appDid ?? null) || existing.siteOwner !== siteOwner) {
        throw new DomainError('domain_conflict', 'Revoke the active binding before changing its app', 409);
      }
      return binding(existing);
    }
    const [row] = await tx.insert(domainBindings).values({
      id: `dom_${randomUUID()}`, domain, zoneOwner: input.zoneOwner, siteOwner,
      appDid: input.appDid ?? null, method: 'dns-txt', status: 'pending',
    }).onConflictDoUpdate({
      target: [domainBindings.domain, domainBindings.zoneOwner],
      set: { siteOwner, appDid: input.appDid ?? null, method: 'dns-txt', status: 'pending',
        attestation: null, verifiedAt: null, checkedAt: null },
    }).returning();
    return binding(row);
  });
}

/** Only exact DID records count; unavailable DNS cannot refresh evidence. */
async function hasTxtProof(domain: string, zoneOwner: string): Promise<boolean> {
  try {
    const records = await resolver.resolveTxt(`_imajin.${domain}`);
    return records.some((chunks) => chunks.join('') === zoneOwner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND') return false;
    throw new DomainError('dns_unavailable', 'DNS lookup unavailable; retry verification', 503);
  }
}

async function transition(tx: Transaction, row: DomainBindingRow, status: 'verified' | 'revoked'): Promise<DomainBinding> {
  const now = new Date();
  const signer = await domainSigningIdentity(row.method === 'imajin-issued');
  if (row.method === 'imajin-issued' && signer.issuerDid !== row.zoneOwner) {
    throw new DomainError('issuer_unavailable', 'Organization identity changed; binding requires review', 503);
  }
  const prepared = await prepareMechanicalAttestation({
    subjectDid: row.method === 'imajin-issued' ? row.siteOwner : row.zoneOwner,
    type: status === 'verified' ? 'domain.verified' : 'domain.revoked',
    contextId: row.domain, contextType: 'domain',
    payload: { domain: row.domain, did: row.method === 'imajin-issued' ? row.siteOwner : row.zoneOwner, zoneOwner: row.zoneOwner,
      siteOwner: row.siteOwner, appDid: row.appDid, method: row.method,
      verifiedAt: status === 'verified' ? now.toISOString() : row.verifiedAt?.toISOString() ?? null,
      checkedAt: now.toISOString(), ...(status === 'revoked' ? { revokedAt: now.toISOString() } : {}) },
  }, undefined, signer);
  const publicAttestation = { ...prepared, issuedAt: prepared.issuedAt.toISOString() };
  if (status === 'verified') {
    // Only proven control supersedes routing-only grandfathering, atomically.
    await tx.update(domainBindings).set({ status: 'revoked', checkedAt: now }).where(and(
      eq(domainBindings.domain, row.domain), eq(domainBindings.status, 'legacy'),
    ));
  }
  await tx.insert(attestations).values({ ...prepared, disclosureScope: 'public' });
  if (status === 'revoked' && row.attestation?.id) {
    await tx.update(attestations).set({ revokedAt: now }).where(eq(attestations.id, String(row.attestation.id)));
  }
  const [updated] = await tx.update(domainBindings).set({
    status, method: row.method, attestation: publicAttestation, checkedAt: now,
    verifiedAt: status === 'verified' ? now : row.verifiedAt,
  }).where(eq(domainBindings.id, row.id)).returning();
  return binding(updated);
}

export async function verifyDomain(input: string, zoneOwner: string): Promise<DomainBinding> {
  const domain = normalizeDomain(input);
  return await db.transaction(async (tx) => {
    await lockDomain(tx, domain);
    const row = await claim(tx, domain, zoneOwner);
    if (!row) throw new DomainError('domain_not_found', 'Domain claim not found', 404);
    if (row.method === 'imajin-issued') throw new DomainError('invalid_method', 'This binding does not use DNS verification', 409);
    if (row.status === 'revoked') throw new DomainError('domain_revoked', 'Add a new claim before re-verifying', 409);
    await assertNoVerifiedCompetitor(tx, domain, zoneOwner);
    const failure = await verificationFailure(tx, row);
    if (failure && row.status === 'verified') return transition(tx, row, 'revoked');
    if (failure) throw failure;
    if (row.status === 'verified') {
      const [checked] = await tx.update(domainBindings).set({ checkedAt: new Date() })
        .where(eq(domainBindings.id, row.id)).returning();
      return binding(checked);
    }
    return transition(tx, { ...row, method: 'dns-txt' }, 'verified');
  });
}

async function verificationFailure(tx: Transaction, row: DomainBindingRow): Promise<DomainError | null> {
  try {
    const owner = await resolveSiteOwner(tx, row.zoneOwner, row.domain, row.appDid);
    if (owner !== row.siteOwner) return new DomainError('app_owner_changed', 'Re-add claim with the current app owner', 409);
    if (!await hasTxtProof(row.domain, row.zoneOwner)) {
      return new DomainError('txt_not_found', 'Publish your exact zone owner DID at _imajin.' + row.domain, 409);
    }
    return null;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
}

export async function removeDomain(input: string, zoneOwner: string): Promise<void> {
  const domain = normalizeDomain(input);
  await db.transaction(async (tx) => {
    await lockDomain(tx, domain);
    const row = await claim(tx, domain, zoneOwner);
    if (!row) throw new DomainError('domain_not_found', 'Domain claim not found', 404);
    if (row.status !== 'revoked') await transition(tx, row, 'revoked');
  });
}

export async function listDomains(did: string, publicOnly = false): Promise<DomainBinding[]> {
  const rows = await db.select().from(domainBindings).where(and(
    or(eq(domainBindings.zoneOwner, did), eq(domainBindings.siteOwner, did)),
    publicOnly ? and(eq(domainBindings.status, 'verified'), isNotNull(domainBindings.attestation)) : undefined,
  )).orderBy(asc(domainBindings.domain));
  if (!publicOnly) return rows.map(binding);
  const current = await Promise.all(rows.map(async (row) => await hasCurrentSiteOwner(row) ? binding(row) : null));
  return current.filter((row): row is DomainBinding => row !== null);
}

export async function resolveVerifiedDomain(input: string): Promise<DomainBinding | null> {
  const domain = normalizeDomain(input);
  const [row] = await db.select().from(domainBindings).where(and(
    eq(domainBindings.domain, domain), eq(domainBindings.status, 'verified'), isNotNull(domainBindings.attestation),
  )).limit(1);
  return row && await hasCurrentSiteOwner(row) ? binding(row) : null;
}

/** Grandfathered rows are routing-only and NEVER ownership or vault evidence. */
export async function resolveRoutableDomain(input: string): Promise<DomainBinding | null> {
  const verified = await resolveVerifiedDomain(input);
  if (verified) return verified;
  const domain = normalizeDomain(input);
  const [legacy] = await db.select().from(domainBindings).where(and(
    eq(domainBindings.domain, domain), eq(domainBindings.status, 'legacy'), eq(domainBindings.method, 'legacy'),
  )).limit(1);
  if (!legacy) return null;
  log.warn({ domain }, 'Routing grandfathered domain without verified ownership evidence');
  return binding(legacy);
}

/** Trusted provisioning path only; never expose this directly as a public API. */
export async function issueImajinDomain(input: { domain: string; appDid: string }): Promise<DomainBinding> {
  const domain = normalizeDomain(input.domain);
  if (!domain.endsWith('.imajin.ai') || domain.split('.').length !== 3) {
    throw new DomainError('invalid_domain', 'Only direct Imajin subdomains may be issued');
  }
  const [nodeHost] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.subdomain, domain)).limit(1);
  if (RESERVED_LABELS.has(domain.split('.')[0]) || nodeHost) {
    throw new DomainError('reserved_domain', 'Infrastructure domains cannot be issued to apps', 403);
  }
  const org = await getImajinOrganization();
  return db.transaction(async (tx) => {
    await lockDomain(tx, domain);
    await assertNoVerifiedCompetitor(tx, domain, org.id);
    const siteOwner = await resolveSiteOwner(tx, org.id, domain, input.appDid, true);
    const existing = await claim(tx, domain, org.id);
    if (existing?.status === 'verified') {
      if (existing.appDid !== input.appDid || existing.siteOwner !== siteOwner) {
        throw new DomainError('domain_conflict', 'Domain already belongs to another site', 409);
      }
      return binding(existing);
    }
    const [row] = await tx.insert(domainBindings).values({
      id: `dom_${randomUUID()}`, domain, zoneOwner: org.id, siteOwner,
      appDid: input.appDid, method: 'imajin-issued', status: 'pending',
    }).onConflictDoUpdate({
      target: [domainBindings.domain, domainBindings.zoneOwner],
      set: { siteOwner, appDid: input.appDid, method: 'imajin-issued', status: 'pending' },
    }).returning();
    return transition(tx, row, 'verified');
  });
}

/** Bounded batches; oldest checks go first, and each row re-reads under lock. */
export async function recheckDomains(limit = 100): Promise<{ checked: number; revoked: number; failed: number }> {
  const rows = await db.select().from(domainBindings).where(and(
    eq(domainBindings.status, 'verified'), eq(domainBindings.method, 'dns-txt'),
    or(isNull(domainBindings.checkedAt), lt(domainBindings.checkedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))),
  )).orderBy(asc(domainBindings.checkedAt)).limit(Math.max(1, Math.min(limit, 500)));
  const result = { checked: 0, revoked: 0, failed: 0 };
  await forEachSequential(rows, async (row) => {
    try {
      const checked = await verifyDomain(row.domain, row.zoneOwner);
      result.checked++;
      if (checked.status === 'revoked') result.revoked++;
    } catch {
      result.failed++;
      log.warn({ domain: row.domain }, 'Domain recheck failed; no ownership evidence was changed');
    }
  });
  return result;
}
