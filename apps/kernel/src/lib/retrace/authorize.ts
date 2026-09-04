/**
 * Retrace (#1962) per-hop authorization.
 *
 * "The caller sees only hops they're authorised to read (subject,
 * identity_members member, or existing grant/disclosed-relation checks —
 * reuse them)." Composed entirely from existing primitives:
 *   - `isPartyToAttestation` / `resolveDisclosureAccess` (#1885, disclosure-access.ts)
 *   - `isActiveGroupMember` (#1851, group-membership.ts)
 *
 * A hop this returns `false` for is never dropped from the chain — the
 * caller renders it as an opaque tombstone instead (see `walk.ts`), so
 * cross-org chains stay walkable to the boundary without leaking.
 */
import { isPartyToAttestation, resolveDisclosureAccess } from '@/src/lib/auth/disclosure-access';
import { isActiveGroupMember } from '@/src/lib/auth/group-membership';
import type { HopAudience } from './types';

/** Is `viewerDid` a direct party (subject, actor, or delegator) to this hop? */
function isDirectParty(viewerDid: string, audience: HopAudience): boolean {
  return isPartyToAttestation(viewerDid, {
    subjectDid: audience.subjectDid,
    actorDid: audience.actorDid,
    delegatorDid: audience.delegatorDid,
  });
}

/** Is `viewerDid` an active `identity_members` member of either org-scope principal on this hop? */
async function isOrgMember(viewerDid: string, audience: HopAudience): Promise<boolean> {
  const [subjectMember, actorMember] = await Promise.all([
    isActiveGroupMember(audience.subjectDid, viewerDid),
    isActiveGroupMember(audience.actorDid, viewerDid),
  ]);
  return subjectMember || actorMember;
}

/**
 * Resolve whether `viewerDid` may read a hop with the given audience.
 *
 * `connectedDids` is the viewer's trust-graph neighborhood (radius 1),
 * resolved once per request by the caller (see `repository.ts`'s
 * `createDefaultRepository`) rather than per hop.
 */
export async function canReadHop(
  viewerDid: string,
  audience: HopAudience,
  connectedDids: ReadonlySet<string> | null,
): Promise<boolean> {
  if (isDirectParty(viewerDid, audience)) return true;
  if (await isOrgMember(viewerDid, audience)) return true;
  if (!audience.disclosureScope) return false;

  return resolveDisclosureAccess(
    audience.disclosureScope,
    viewerDid,
    { subjectDid: audience.subjectDid, actorDid: audience.actorDid, delegatorDid: audience.delegatorDid },
    connectedDids,
  );
}
