import { and, eq } from 'drizzle-orm';
import { db, identities, registryApps } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { DomainError } from '@/src/lib/domains/normalize';

const log = createLogger('kernel:apps:domains');

/** Explicit owner choices must resolve before provisioning creates anything. */
export async function validateProvisionOwner(did?: string): Promise<void> {
  if (!did) return;
  const [owner] = await db.select({ id: identities.id }).from(identities)
    .where(eq(identities.id, did)).limit(1);
  if (!owner) throw new Error('Site owner identity does not exist');
}

/**
 * Attempt an org-issued host, including dev-* slugs. Missing signing
 * prerequisites defer the binding, never the app's signing-key claim. A retry
 * never transfers an existing app to a different owner. Custom domains use
 * the TXT ceremony rather than this zone-owner issuance path.
 */
export async function provisionAppDomain(
  appDid: string,
  slug: string,
  requestedDomain?: string,
  requestedOwner?: string,
): Promise<void> {
  // Service-scope minting imports the provisioning approval vocabulary.
  // Do not initialize DNS, node identity or vault signing on that read path.
  const { issueImajinDomain, normalizeDomain } = await import('@/src/lib/domains/service');
  const domain = normalizeDomain(requestedDomain ?? `${slug}.imajin.ai`);
  if (!/^[a-z0-9-]+\.imajin\.ai$/.test(domain)) {
    throw new Error('Provisioned hosts must be direct imajin.ai subdomains; custom domains require TXT verification');
  }
  const [app] = await db.select({ ownerDid: registryApps.ownerDid }).from(registryApps)
    .where(and(eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'))).limit(1);
  if (!app || (requestedOwner && app.ownerDid !== requestedOwner)) {
    throw new Error('Provisioning cannot change an existing app owner');
  }
  try {
    await issueImajinDomain({ domain, appDid });
  } catch (error) {
    if (!(error instanceof DomainError)
      || !['issuer_unavailable', 'credential_unavailable'].includes(error.code)) throw error;
    log.warn({}, 'App domain issuance deferred: organization signing is unavailable; retry the approved host after setup');
  }
}
