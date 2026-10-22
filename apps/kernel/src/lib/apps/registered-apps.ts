import { asc, sql } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';

export type RegisteredAppKind = 'MCP/DCR client' | 'delegated app' | 'first-party seed';
export type RegisteredAppStatus = 'active' | 'dormant' | 'expired' | 'revoked';
export interface AppProvenancePoint { at: string | null; by: string | null }
export interface RegisteredApp {
  id: string;
  appDid: string;
  name: string;
  kind: RegisteredAppKind;
  status: RegisteredAppStatus;
  created: AppProvenancePoint;
  firstConsent: AppProvenancePoint;
  consentingPrincipals: number;
  lastSeen: string | null;
  ended: AppProvenancePoint;
}

interface RegistryLifecycleRow {
  id: string; appDid: string; name: string; tier: string; status: string;
  createdAt: Date | string | null; ownerDid: string;
  registrar: string | null; consentAt: string | null; consentBy: string | null;
  consentingPrincipals: number; hasConsent: boolean; hasProvision: boolean; hasClaim: boolean;
  provisionAt: string | null; claimAt: string | null; lastSeen: string | null;
  endedAt: Date | string | null; endedBy: string | null;
}

function timestamp(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** A display projection only: never persist dormant or repair old registry rows. */
export function registeredApp(row: RegistryLifecycleRow, now = Date.now()): RegisteredApp {
  const lastSeen = timestamp(row.lastSeen);
  const baseline = [lastSeen, timestamp(row.createdAt), row.consentAt, row.provisionAt, row.claimAt]
    .filter((at): at is string => at !== null).map(at => Date.parse(at));
  const protectedApp = row.hasConsent || row.hasProvision || row.hasClaim || row.tier === 'first_party';
  const dormant = protectedApp && baseline.length > 0
    && now - Math.max(...baseline) >= 90 * 24 * 60 * 60 * 1000;
  let status: RegisteredAppStatus = 'active';
  if (row.status === 'expired' || row.status === 'revoked') status = row.status;
  else if (dormant) status = 'dormant';
  let kind: RegisteredAppKind = 'delegated app';
  if (row.appDid.startsWith('did:imajin:mcp-')) kind = 'MCP/DCR client';
  else if (row.tier === 'first_party' && !row.hasProvision && !row.hasClaim) kind = 'first-party seed';
  return {
    id: row.id, appDid: row.appDid, name: row.name, kind, status,
    created: { at: timestamp(row.createdAt), by: row.registrar?.trim() || row.ownerDid?.trim() || null },
    firstConsent: { at: timestamp(row.consentAt), by: row.consentBy },
    consentingPrincipals: Number(row.consentingPrincipals),
    lastSeen,
    ended: { at: timestamp(row.endedAt), by: row.endedBy },
  };
}

/**
 * Correlated metadata aggregates keep history (including revoked consents and
 * consumed refresh tokens), without loading any bearer, hash, or payload.
 * No status/visibility filter: legacy, internal and terminal apps remain auditable.
 */
export async function listRegisteredApps(): Promise<RegisteredApp[]> {
  const rows = await db.select({
    id: registryApps.id, appDid: registryApps.appDid, name: registryApps.name,
    tier: registryApps.tier, status: registryApps.status,
    createdAt: registryApps.createdAt, ownerDid: registryApps.ownerDid,
    registrar: sql<string | null>`(select issuer_did from auth.attestations
      where subject_did = ${registryApps.appDid} and type = 'registry.app.registered'
      order by issued_at, id limit 1)`,
    consentAt: sql<string | null>`(select min(issued_at) from auth.attestations
      where subject_did = ${registryApps.appDid} and type = 'app.authorized')`,
    consentBy: sql<string | null>`(select issuer_did from auth.attestations
      where subject_did = ${registryApps.appDid} and type = 'app.authorized'
      order by issued_at, id limit 1)`,
    consentingPrincipals: sql<number>`(select count(distinct issuer_did)::int from auth.attestations
      where subject_did = ${registryApps.appDid} and type = 'app.authorized'
      and revoked_at is null and (expires_at is null or expires_at > now()))`,
    hasConsent: sql<boolean>`exists(select 1 from auth.attestations
      where subject_did = ${registryApps.appDid} and type = 'app.authorized')`,
    hasProvision: sql<boolean>`exists(select 1 from kernel.app_provisions where app_did = ${registryApps.appDid})`,
    hasClaim: sql<boolean>`exists(select 1 from kernel.app_signing_key_claims where app_did = ${registryApps.appDid})`,
    provisionAt: sql<string | null>`(select max(created_at) from kernel.app_provisions where app_did = ${registryApps.appDid})`,
    claimAt: sql<string | null>`(select max(coalesce(claimed_at, created_at))
      from kernel.app_signing_key_claims where app_did = ${registryApps.appDid})`,
    lastSeen: sql<string | null>`greatest(
      (select max(greatest(created_at, last_used_at)) from auth.oauth_refresh_tokens where client_id = ${registryApps.id}),
      (select max(created_at) from registry.system_events where did = ${registryApps.appDid}
        and action in ('app.token.minted', 'app.authorization.validated')),
      (select max(created_at) from registry.app_logs
        where (metadata->>'appDid' = ${registryApps.appDid}
          or metadata->>'aud' = any(${registryApps.tokenAudiences}))
        and message in ('minted app token', 'minted app service token', 'minted session app token'))
    )`,
    endedAt: registryApps.revokedAt,
    endedBy: sql<string | null>`(select issuer_did from auth.attestations
      where subject_did = ${registryApps.appDid}
        and type = case when ${registryApps.status} = 'expired' then 'registry.app.expired' else 'registry.app.revoked' end
      order by issued_at desc, id desc limit 1)`,
  }).from(registryApps).orderBy(asc(registryApps.name), asc(registryApps.id));
  const now = Date.now();
  return rows.map(row => registeredApp(row, now));
}
