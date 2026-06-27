import type { FairManifest } from '@imajin/fair';

/**
 * Canonical per-asset READ authorization for the `.fair` access model.
 *
 * Single source of truth shared by the media HTTP routes
 * (GET /media/api/assets/[id], /content) and — next — the MCP media READ tools
 * (#1166). Extracted verbatim from the [id] serve route so behavior is unchanged.
 *
 * Fixing the two known gaps happens HERE (one place), not in each caller:
 *   - #1167: GET /content is still owner-only and should adopt canReadAsset.
 *   - #1168: `conversation` currently allows any authenticated DID; it should be
 *            gated on membership via FairAccess.conversationDid.
 */

export type AssetAccessType = 'public' | 'private' | 'trust-graph' | 'conversation';

/** Resolve the `.fair` access type, handling both the string and object forms. */
export function getAccessType(access: FairManifest['access']): AssetAccessType {
  if (!access) return 'private';
  if (access === 'public') return 'public';
  if (access === 'private') return 'private';
  return access.type;
}

/** DIDs explicitly granted read access (trust-graph `allowedDids`). */
export function getAllowedDids(access: FairManifest['access']): string[] {
  if (!access || typeof access === 'string') return [];
  return access.allowedDids ?? [];
}

export interface AssetReadSubject {
  ownerDid: string;
  access: FairManifest['access'];
}

export type ReadDecision =
  | { allowed: true; requiresAuth: boolean; accessType: AssetAccessType }
  | { allowed: false; requiresAuth: boolean; accessType: AssetAccessType; reason: string };

/**
 * Decide whether `requesterDid` (null = unauthenticated) may READ the asset.
 *
 *   public:       anyone, no auth required
 *   private:      owner only
 *   trust-graph:  owner OR an explicitly granted DID (allowedDids)
 *   conversation: TODO(#1168) — currently any authenticated DID; membership
 *                 gating (FairAccess.conversationDid) is not implemented yet.
 *                 Preserves the prior GET /media/api/assets/[id] behavior.
 */
export function canReadAsset(
  subject: AssetReadSubject,
  requesterDid: string | null,
): ReadDecision {
  const accessType = getAccessType(subject.access);

  if (accessType === 'public') {
    return { allowed: true, requiresAuth: false, accessType };
  }

  if (!requesterDid) {
    return { allowed: false, requiresAuth: true, accessType, reason: 'Authentication required' };
  }

  if (requesterDid === subject.ownerDid) {
    return { allowed: true, requiresAuth: true, accessType };
  }

  switch (accessType) {
    case 'trust-graph':
      return getAllowedDids(subject.access).includes(requesterDid)
        ? { allowed: true, requiresAuth: true, accessType }
        : { allowed: false, requiresAuth: true, accessType, reason: 'Not in trust graph' };
    case 'conversation':
      // TODO(#1168): gate on conversation membership (FairAccess.conversationDid)
      // instead of allowing any authenticated DID.
      return { allowed: true, requiresAuth: true, accessType };
    default:
      // private (owner already handled above) and any unknown type → deny.
      return { allowed: false, requiresAuth: true, accessType, reason: 'Private asset — owner only' };
  }
}
