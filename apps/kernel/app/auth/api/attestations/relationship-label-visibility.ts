import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, identityMembers } from '@/src/db';
import type { Attestation } from '@/src/db';

const LABEL_EVENT = 'connection.relationship.label.changed';

/**
 * A commercial label is an org's private book, not a bilateral fact. Even the
 * counterparty named in its payload must not see it. Unlike legacy mechanical
 * events, these records are private regardless of registry/disclosure settings.
 */
export async function filterRelationshipLabelEvents(
  rows: Attestation[],
  resolveViewer: () => Promise<string | null>,
): Promise<Attestation[]> {
  const orgDids = [...new Set(rows.filter(row => row.type === LABEL_EVENT).map(row => row.subjectDid))];
  if (orgDids.length === 0) return rows;

  const viewerDid = await resolveViewer();
  const memberships = viewerDid ? await db.select({ orgDid: identityMembers.identityDid })
    .from(identityMembers)
    .where(and(
      eq(identityMembers.memberDid, viewerDid),
      inArray(identityMembers.identityDid, orgDids),
      inArray(identityMembers.role, ['owner', 'admin']),
      isNull(identityMembers.removedAt),
    )) : [];
  const allowed = new Set(memberships.map(row => row.orgDid));
  return rows.filter(row => row.type !== LABEL_EVENT || allowed.has(row.subjectDid));
}
