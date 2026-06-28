import type { FairManifest } from '@imajin/fair';

/**
 * Canonical per-asset READ authorization for the `.fair` access model.
 *
 * Single source of truth shared by the media HTTP routes
 * (GET /media/api/assets/[id], /content) and — next — the MCP media READ tools
 * (#1166). Extracted verbatim from the [id] serve route so behavior is unchanged.
 *
 * This is the pure, synchronous core. Conversation membership (#1168) needs a DB
 * lookup, so it is layered on by the async authorizeAssetRead() wrapper in
 * authorize-read.ts — the HTTP routes and MCP tools call that wrapper.
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
 *   conversation: owner only here; non-owner membership is resolved by the async
 *                 authorizeAssetRead() wrapper (deny-by-default otherwise).
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
      // Non-owner conversation access depends on membership, which needs a DB
      // lookup — resolved by authorizeAssetRead() (src/lib/media/authorize-read.ts).
      // Deny here so any caller that skips that async check stays secure (#1168).
      return { allowed: false, requiresAuth: true, accessType, reason: 'Conversation membership required' };
    default:
      // private (owner already handled above) and any unknown type → deny.
      return { allowed: false, requiresAuth: true, accessType, reason: 'Private asset — owner only' };
  }
}
