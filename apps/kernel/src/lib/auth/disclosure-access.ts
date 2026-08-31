/**
 * disclosure_scope access control (#1885).
 *
 * Kept pure and storage-independent so the four-value enum's access rules
 * are unit-testable without a database. `GET /auth/api/attestations` wires
 * this against a viewer DID (optional — the route stays anonymous-callable
 * for legacy types) and a "connections" set resolved once per request via
 * `@imajin/trust-graph`'s `trustRadius`.
 */
import type { DisclosureScope } from '@imajin/auth';

export interface DisclosureAudience {
  subjectDid: string;
  actorDid: string;
  delegatorDid?: string | null;
}

/** True when the viewer is the subject, the actor, or the delegator. */
export function isPartyToAttestation(viewerDid: string, audience: DisclosureAudience): boolean {
  return (
    viewerDid === audience.subjectDid ||
    viewerDid === audience.actorDid ||
    (audience.delegatorDid != null && viewerDid === audience.delegatorDid)
  );
}

/**
 * Resolve whether `viewerDid` (null = anonymous) may see a row with the
 * given `disclosure_scope`.
 *
 * `connectedDids` is the viewer's trust-graph neighborhood (radius 1),
 * resolved once per request by the caller — not per row — to avoid an
 * N+1 query pattern.
 */
export function resolveDisclosureAccess(
  scope: DisclosureScope,
  viewerDid: string | null,
  audience: DisclosureAudience,
  connectedDids: ReadonlySet<string> | null,
): boolean {
  switch (scope) {
    case 'public':
      return true;
    case 'network':
      return viewerDid !== null;
    case 'connections':
      if (viewerDid === null) return false;
      if (isPartyToAttestation(viewerDid, audience)) return true;
      return Boolean(
        connectedDids && (connectedDids.has(audience.subjectDid) || connectedDids.has(audience.actorDid)),
      );
    case 'parties':
      return viewerDid !== null && isPartyToAttestation(viewerDid, audience);
  }
}
