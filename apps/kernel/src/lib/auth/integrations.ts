import { and, eq, inArray } from 'drizzle-orm';
import { db, attestations, registryApps, channelLinks, identities } from '@/src/db';
import { dedupeAttestationsBySubject } from './grant-dedupe';

/**
 * Unified "integrations granted to my DID" read model (#1171).
 *
 * Collapses the parallel grant surfaces into one list:
 *   - `app.authorized` attestations (OAuth public-client #1169 AND app-keypair
 *     console grants both record consent as this attestation), deduped per subject.
 *   - `channel_links` (messenger/bot links).
 *
 * Each row is enriched from the actor identity (auth.identities — the promoted
 * member, #1171) for the name + the "client, not a person" agent badge, and from
 * the registry.apps adapter binding for logo. Storage stays separate (per the
 * ticket: unify the read seam, not the tables).
 */

export interface GrantedIntegration {
  /** The integration's actor DID (the grant subject / appDid). */
  subjectDid: string;
  source: 'app.authorized' | 'channel-link';
  scopes: string[];
  grantedAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
  grantRef:
    | { kind: 'attestation'; attestationId: string }
    | { kind: 'channel-link'; id: string; channel: string };
  // Enrichment
  name: string | null;
  logoUrl: string | null;
  /** subtype === 'agent' → render the "client, not a person" badge. */
  isAgent: boolean;
  /** Has a real auth.identities row (a promoted member vs a bare credential). */
  isMember: boolean;
}

/** List the integrations `ownerDid` has granted access to (active + revoked). */
export async function listGrantedIntegrations(ownerDid: string): Promise<GrantedIntegration[]> {
  const [rawAtts, links] = await Promise.all([
    db
      .select({
        id: attestations.id,
        subjectDid: attestations.subjectDid,
        payload: attestations.payload,
        issuedAt: attestations.issuedAt,
        revokedAt: attestations.revokedAt,
      })
      .from(attestations)
      .where(and(eq(attestations.issuerDid, ownerDid), eq(attestations.type, 'app.authorized'))),
    db.select().from(channelLinks).where(eq(channelLinks.did, ownerDid)),
  ]);

  const atts = dedupeAttestationsBySubject(rawAtts);

  const subjectDids = [...new Set<string>([...atts.map((a) => a.subjectDid), ...links.map((l) => l.appDid)])];
  const [apps, members] = subjectDids.length === 0
    ? [[], []]
    : await Promise.all([
        db
          .select({ appDid: registryApps.appDid, name: registryApps.name, logoUrl: registryApps.logoUrl })
          .from(registryApps)
          .where(inArray(registryApps.appDid, subjectDids)),
        db
          .select({ id: identities.id, name: identities.name, subtype: identities.subtype })
          .from(identities)
          .where(inArray(identities.id, subjectDids)),
      ]);

  const appByDid = new Map(apps.map((a) => [a.appDid, a]));
  const memberByDid = new Map(members.map((m) => [m.id, m]));

  function enrich(subjectDid: string) {
    const app = appByDid.get(subjectDid);
    const member = memberByDid.get(subjectDid);
    return {
      name: member?.name ?? app?.name ?? null,
      logoUrl: app?.logoUrl ?? null,
      isAgent: member?.subtype === 'agent',
      isMember: !!member,
    };
  }

  const out: GrantedIntegration[] = [];

  for (const a of atts) {
    const payload = a.payload as { scopes?: string[] } | null;
    out.push({
      subjectDid: a.subjectDid,
      source: 'app.authorized',
      scopes: payload?.scopes ?? [],
      grantedAt: a.issuedAt,
      revokedAt: a.revokedAt,
      active: !a.revokedAt,
      grantRef: { kind: 'attestation', attestationId: a.id },
      ...enrich(a.subjectDid),
    });
  }

  for (const l of links) {
    out.push({
      subjectDid: l.appDid,
      source: 'channel-link',
      scopes: Array.isArray(l.scopes) ? (l.scopes as string[]) : [],
      grantedAt: l.createdAt ?? null,
      revokedAt: l.revokedAt ?? null,
      active: l.status === 'active',
      grantRef: { kind: 'channel-link', id: l.id, channel: l.channel },
      ...enrich(l.appDid),
    });
  }

  return out;
}
