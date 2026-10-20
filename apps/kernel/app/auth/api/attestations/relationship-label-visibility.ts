import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, identityMembers } from '@/src/db';
import type { Attestation } from '@/src/db';

export const RELATIONSHIP_LABEL_EVENT = 'connection.relationship.label.changed';
/** Live org books the real viewer may read; act-as identity alone is not authority. */
export async function relationshipLabelOrgDids(viewerDid: string | null, orgDids: string[]): Promise<string[]> {
  if (!viewerDid || orgDids.length === 0) return [];
  const memberships = await db.select({ orgDid: identityMembers.identityDid })
    .from(identityMembers)
    .where(and(
      eq(identityMembers.memberDid, viewerDid),
      inArray(identityMembers.identityDid, orgDids),
      inArray(identityMembers.role, ['owner', 'admin']),
      isNull(identityMembers.removedAt),
    ));
  return memberships.map(row => row.orgDid);
}

/**
 * A commercial label is an org's private book, not a bilateral fact. Even the
 * counterparty named in its payload must not see it. Unlike legacy mechanical
 * events, these records are private regardless of registry/disclosure settings.
 */
export async function filterRelationshipLabelEvents(
  rows: Attestation[],
  resolveViewer: () => Promise<string | null>,
): Promise<Attestation[]> {
  const orgDids = [...new Set(rows.filter(row => row.type === RELATIONSHIP_LABEL_EVENT).map(row => row.subjectDid))];
  if (orgDids.length === 0) return rows;

  const viewerDid = await resolveViewer();
  const allowed = new Set(await relationshipLabelOrgDids(viewerDid, orgDids));
  return rows.filter(row => row.type !== RELATIONSHIP_LABEL_EVENT || allowed.has(row.subjectDid));
}
