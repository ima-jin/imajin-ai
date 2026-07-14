import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, consentGrants, brokerAuditLog, contactMetadata } from '@/src/db';

export type RelationshipType = 'business' | 'group' | 'person' | 'collective';

export interface ContactSummary {
  did: string;
  label: string | null;
  relationshipType: RelationshipType | null;
  activeGrants: number;
  revokedGrants: number;
  purposes: string[];
  lastDisclosureAt: string | null;
}

function isActive(status: string, expiresAt: Date | null): boolean {
  return status === 'active' && (expiresAt === null || expiresAt.getTime() > Date.now());
}

/**
 * GET /api/broker/contacts — "who have I shared with?" (#1053).
 *
 * Aggregates the acting subject's consent grants by recipient DID and attaches
 * the timestamp of the most recent release to each recipient. Subjects only
 * ever see their own grants (fail-closed). Class grants (#1189, NULL grantedTo)
 * are excluded from the contact view.
 */
export async function getContacts(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const subject = resolveActingDid(auth.identity);

  const grants = await db
    .select()
    .from(consentGrants)
    .where(eq(consentGrants.subject, subject));

  const releases = await db
    .select({ requester: brokerAuditLog.requester, createdAt: brokerAuditLog.createdAt })
    .from(brokerAuditLog)
    .where(and(eq(brokerAuditLog.subject, subject), eq(brokerAuditLog.type, 'release')));

  // Fetch all contact metadata for the subject in one query.
  const metaRows = await db
    .select({ did: contactMetadata.did, label: contactMetadata.label, relationshipType: contactMetadata.relationshipType })
    .from(contactMetadata)
    .where(eq(contactMetadata.subject, subject));
  const metaByDid = new Map(metaRows.map((m) => [m.did, m]));

  const lastByRequester = new Map<string, number>();
  for (const r of releases) {
    const t = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (t > (lastByRequester.get(r.requester) ?? 0)) lastByRequester.set(r.requester, t);
  }

  interface Acc { active: number; revoked: number; purposes: Set<string>; }
  const byContact = new Map<string, Acc>();
  for (const g of grants) {
    if (!g.grantedTo) continue; // class grants (#1189) are not per-contact
    let acc = byContact.get(g.grantedTo);
    if (!acc) {
      acc = { active: 0, revoked: 0, purposes: new Set<string>() };
      byContact.set(g.grantedTo, acc);
    }
    if (g.status === 'revoked') acc.revoked += 1;
    else if (isActive(g.status, g.expiresAt)) acc.active += 1;
    acc.purposes.add(g.purpose);
  }

  const VALID_TYPES = new Set<string>(['business', 'group', 'person', 'collective']);

  const contacts: ContactSummary[] = [...byContact.entries()].map(([did, acc]) => {
    const last = lastByRequester.get(did);
    const meta = metaByDid.get(did);
    const rawType = meta?.relationshipType ?? null;
    return {
      did,
      label: meta?.label ?? null,
      relationshipType: rawType !== null && VALID_TYPES.has(rawType) ? (rawType as RelationshipType) : null,
      activeGrants: acc.active,
      revokedGrants: acc.revoked,
      purposes: [...acc.purposes].sort((a, b) => a.localeCompare(b)),
      lastDisclosureAt: last ? new Date(last).toISOString() : null,
    };
  });

  contacts.sort((a, b) => {
    const at = a.lastDisclosureAt ? Date.parse(a.lastDisclosureAt) : 0;
    const bt = b.lastDisclosureAt ? Date.parse(b.lastDisclosureAt) : 0;
    if (bt !== at) return bt - at;
    return a.did.localeCompare(b.did);
  });

  return NextResponse.json({ contacts });
}
