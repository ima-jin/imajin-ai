import { requireAppAuth, requireAuth } from '@imajin/auth';
import type { NextRequest } from 'next/server';
import { resolveVerifiedDomain } from '@/src/lib/domains/service';
import { introspectGrant } from '@/src/lib/auth/grants';
import { controlsImportOwner, isImportHuman } from '@/src/lib/vault/import-authority';
import { resolveDomainCredential } from '@/src/lib/vault/domain-credential';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { CloudflareClient } from './client';
import { CloudflareError, domainSchema, idSchema, parse } from './schemas';
import { z } from 'zod';
import { cloudflarePurpose, cloudflareZoneDid } from './contract';
import { db, delegationGrants } from '@/src/db';
import { eq } from 'drizzle-orm';

export interface CloudflareActor { did: string; humanSession: boolean }
export interface ZoneAuthority {
  actor: CloudflareActor; ownerDid: string; domain: string; zoneId: string; client: CloudflareClient;
}

/** Actual authenticated identity only. Group act-as and acting-for never replace attribution. */
export async function authenticateCloudflare(request: NextRequest, capability: string): Promise<CloudflareActor> {
  if (request.headers.has('authorization') || request.headers.has('x-app-did')) {
    const app = await requireAppAuth(request, { scope: capability });
    if ('appAuth' in app) {
      return { did: app.appAuth.isServiceToken ? app.appAuth.appDid : app.appAuth.userDid, humanSession: false };
    }
    if (!app.notAppToken) throw new CloudflareError(app.status, 'authentication_failed');
  }
  const session = await requireAuth(request);
  if ('error' in session) throw new CloudflareError(session.status, 'authentication_failed');
  return { did: session.identity.id, humanSession: !session.identity.actingFor };
}

export async function authorizeZone(actor: CloudflareActor, zoneId: string, domain: string, capability: string): Promise<ZoneAuthority> {
  parse(idSchema, zoneId);
  parse(domainSchema, domain);
  if (!actor.did) throw new CloudflareError(401, 'authentication_required');
  const binding = await resolveVerifiedDomain(domain);
  if (!binding || binding.domain !== domain) throw new CloudflareError(403, 'zone_not_verified');
  const owner = actor.humanSession && await isImportHuman(actor.did)
    && await controlsImportOwner(actor.did, binding.zoneOwner);
  if (!owner) {
    const grant = await introspectGrant({
      agentDid: actor.did, capability, targetDid: cloudflareZoneDid(zoneId), delegatorDid: binding.zoneOwner,
    });
    if (!grant.authorized) throw new CloudflareError(403, 'capability_required');
    const [scoped] = await db.select({ audience: delegationGrants.audience }).from(delegationGrants)
      .where(eq(delegationGrants.id, grant.grantId!)).limit(1);
    const audience = scoped?.audience as { type?: string; values?: string[] } | undefined;
    if (audience?.type !== 'dids' || !audience.values?.includes(cloudflareZoneDid(zoneId))) {
      throw new CloudflareError(403, 'zone_audience_required');
    }
  }
  let secret: string;
  try {
    secret = await resolveDomainCredential(domain, getNodeSigningIdentity().senderDid, cloudflarePurpose(zoneId));
  } catch {
    throw new CloudflareError(409, 'credential_unavailable');
  }
  const client = new CloudflareClient(secret, zoneId);
  const zone = await client.request('', z.object({ id: idSchema, name: domainSchema }).strip());
  if (zone.id !== zoneId || zone.name !== domain) throw new CloudflareError(403, 'zone_domain_mismatch');
  // Credential lookup itself re-resolves the binding; also reject a changed owner.
  const current = await resolveVerifiedDomain(domain);
  if (current?.zoneOwner !== binding.zoneOwner) throw new CloudflareError(403, 'zone_owner_changed');
  return { actor, ownerDid: binding.zoneOwner, domain, zoneId, client };
}
