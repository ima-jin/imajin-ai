import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db, delegationGrants, delegationGrantCapabilities } from '@/src/db';
import { listImportedKeyCards } from '@/src/lib/vault/import';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { resolveVerifiedDomain } from '@/src/lib/domains/service';
import { CLOUDFLARE_CAPABILITIES, cloudflareZoneDid, isCloudflareZoneAudience } from './contract';
import { domainSchema } from './schemas';

/** Read-only discovery, not an authorization cache. Never fetch or unseal a credential. */
export async function listCloudflareZoneGrants(agentDid: string) {
  const rows = await db.select({
    grantId: delegationGrants.id,
    delegatorDid: delegationGrants.delegatorDid,
    audience: delegationGrants.audience,
    issuedAt: delegationGrants.issuedAt,
    expiresAt: delegationGrants.expiresAt,
    capability: delegationGrantCapabilities.capability,
  }).from(delegationGrants).innerJoin(delegationGrantCapabilities,
    eq(delegationGrantCapabilities.grantId, delegationGrants.id))
    .where(and(
      eq(delegationGrants.agentDid, agentDid),
      eq(delegationGrants.status, 'active'),
      gt(delegationGrants.expiresAt, new Date()),
      eq(delegationGrantCapabilities.status, 'active'),
      inArray(delegationGrantCapabilities.capability, [...CLOUDFLARE_CAPABILITIES]),
    )).orderBy(desc(delegationGrants.issuedAt));
  const scoped = rows.filter(row => isCloudflareZoneAudience(row.audience));
  if (!scoped.length) return [];

  const cards = await listImportedKeyCards([...new Set(scoped.map(row => row.delegatorDid))]);
  const nodeDid = getNodeSigningIdentity().senderDid;
  const grants = new Map<string, {
    grantId: string; agentDid: string; delegatorDid: string;
    audience: { type: 'dids'; values: [string] };
    zoneId: string; domain: string; capabilities: string[]; issuedAt: string; expiresAt: string;
  }>();
  for (const row of scoped) {
    const existing = grants.get(row.grantId);
    if (existing) {
      existing.capabilities.push(row.capability);
      continue;
    }
    const audience = row.audience as { type: 'dids'; values: [string] };
    const zoneId = audience.values[0].slice('did:imajin:cloudflare-'.length);
    const candidates = cards.filter(card => card.ownerDid === row.delegatorDid
      && card.consumerDid === nodeDid && card.status === 'active'
      && card.purpose === `dns.cloudflare:${zoneId}` && card.cloudflare?.zoneId === zoneId);
    // Rotated, absent or ambiguous credentials must not suggest usable authority.
    if (candidates.length !== 1) continue;
    const domain = candidates[0].cloudflare!.domain;
    if (!domainSchema.safeParse(domain).success) continue;
    const binding = await resolveVerifiedDomain(domain);
    if (binding?.domain !== domain || binding.zoneOwner !== row.delegatorDid) continue;
    grants.set(row.grantId, {
      grantId: row.grantId, agentDid, delegatorDid: row.delegatorDid,
      audience: { type: 'dids', values: [cloudflareZoneDid(zoneId)] },
      zoneId, domain, capabilities: [row.capability],
      issuedAt: row.issuedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    });
  }
  return [...grants.values()].map(grant => ({ ...grant, capabilities: grant.capabilities.sort() }));
}
