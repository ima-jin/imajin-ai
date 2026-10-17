import { and, eq } from 'drizzle-orm';
import { db, forestConfig, registryApps } from '@/src/db';
import { normalizeDomain, resolveRoutableDomain, resolveVerifiedDomain } from './service';
import { validateEntryUrl } from '@/src/lib/apps/entry-url';

/** Host, not X-Forwarded-Host: forwarded headers are not ownership evidence. */
export function domainFromHost(host: string | null): string | null {
  if (!host || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) return null;
  try {
    return normalizeDomain(host.replace(/:[0-9]+$/, ''));
  } catch {
    return null;
  }
}

export async function publicDomainEvidence(domain: string) {
  const binding = await resolveVerifiedDomain(domain);
  if (!binding?.attestation) return null;
  return {
    siteOwner: binding.siteOwner,
    appDid: binding.appDid,
    zoneOwner: binding.zoneOwner,
    attestation: binding.attestation,
  };
}

/**
 * Existing forest mappings may route with an explicit legacy warning, but
 * only verified rows can produce public ownership evidence or vault grants.
 * Destinations come from the registry/config, never a request parameter.
 */
export async function domainLanding(domain: string): Promise<string | null> {
  const binding = await resolveRoutableDomain(domain);
  if (!binding) return null;
  if (binding.appDid) {
    const [app] = await db.select({ entryUrl: registryApps.entryUrl, ownerDid: registryApps.ownerDid })
      .from(registryApps).where(and(
        eq(registryApps.appDid, binding.appDid), eq(registryApps.status, 'active'),
      )).limit(1);
    if (!app || app.ownerDid !== binding.siteOwner || !app.entryUrl) return null;
    return safeLanding(app.entryUrl, domain);
  }
  const [forest] = await db.select({ landingService: forestConfig.landingService })
    .from(forestConfig).where(eq(forestConfig.groupDid, binding.siteOwner)).limit(1);
  const path = forest?.landingService && /^[a-z][a-z0-9-]*$/.test(forest.landingService)
    ? `/${forest.landingService}` : '/auth';
  return `${path}?scope=${encodeURIComponent(binding.siteOwner)}`;
}

export function safeLanding(entry: string, domain: string): string | null {
  if (!validateEntryUrl(entry).ok) return null;
  try {
    const target = new URL(entry, `https://${domain}`);
    if (normalizeDomain(target.hostname) === normalizeDomain(domain)) {
      if (target.pathname === '/') return null;
      return `${target.pathname}${target.search}${target.hash}`;
    }
    return target.toString();
  } catch {
    return null;
  }
}
