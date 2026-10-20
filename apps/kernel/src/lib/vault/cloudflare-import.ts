import { normalizeDomain, resolveVerifiedDomain } from '@/src/lib/domains/service';
import { cloudflarePurpose, isCloudflareImport } from '@/src/lib/cloudflare/contract';
import { getNodeSigningIdentity } from './sealing';
import type { ImportDetail } from './import-staging';

/** Re-read current canonical ownership at proposal and execution; no provider call here. */
export async function requireCloudflareImportBinding(detail: ImportDetail): Promise<void> {
  if (!detail.cloudflare) return;
  const zone = detail.cloudflare;
  if (!isCloudflareImport(zone) || normalizeDomain(zone.domain) !== zone.domain
    || detail.consumerDid !== getNodeSigningIdentity().senderDid
    || detail.purpose !== cloudflarePurpose(zone.zoneId)) throw new Error('Cloudflare import unavailable');
  const binding = await resolveVerifiedDomain(zone.domain);
  if (!binding || binding.domain !== zone.domain || binding.zoneOwner !== detail.ownerDid) {
    throw new Error('Cloudflare import unavailable');
  }
}

/** Only invoked after countersignature, with the existing sealed staging value in memory. */
export async function verifyCloudflareImportToken(detail: ImportDetail, token: string): Promise<void> {
  if (!detail.cloudflare) return;
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${detail.cloudflare.zoneId}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Unavailable');
    const body = await response.json();
    if (body?.success !== true || body?.result?.id !== detail.cloudflare.zoneId
      || body?.result?.name !== detail.cloudflare.domain) throw new Error('Unavailable');
  } catch {
    // Neither provider response nor network exceptions may cross this boundary.
    throw new Error('Cloudflare zone verification unavailable');
  }
}
