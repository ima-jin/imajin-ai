/**
 * Helpers for cohost management routes.
 * Extracted from app/api/events/[id]/cohosts/route.ts to reduce cognitive complexity.
 */

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://localhost:3005';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

export interface CoHostProfileData {
  name?: string;
  handle?: string;
  avatar?: string;
  avatarUrl?: string;
}

export type ResolveCoHostResult =
  | { error: string; status: number }
  | { coHostDid: string; profileData: CoHostProfileData };

/**
 * Resolve the cohost DID from either a direct DID parameter or a handle string.
 * Looks up the DID via the profile service when a handle is provided.
 */
export async function resolveCoHostDid(
  didParam: unknown,
  handle: unknown,
): Promise<ResolveCoHostResult> {
  if (didParam && typeof didParam === 'string') {
    const profileData = await resolveProfileByDid(didParam);
    return { coHostDid: didParam, profileData };
  }

  if (typeof handle !== 'string') {
    return { error: 'handle must be a string', status: 400 };
  }

  try {
    const res = await fetch(
      `${PROFILE_SERVICE_URL}/api/profile/by-handle/${encodeURIComponent(handle.replace(/^@/, ''))}`,
      { cache: 'no-store' },
    );
    if (!res.ok) {
      return { error: 'Handle not found', status: 404 };
    }
    const data = await res.json();
    const coHostDid: string = data.did;
    if (!coHostDid) {
      return { error: 'Could not resolve DID for handle', status: 404 };
    }
    return { coHostDid, profileData: data };
  } catch {
    return { error: 'Failed to look up handle', status: 502 };
  }
}

/** Resolve basic profile data (name/handle/avatar) for a known DID. */
async function resolveProfileByDid(did: string): Promise<CoHostProfileData> {
  try {
    const res = await fetch(
      `${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`,
      { cache: 'no-store' },
    );
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        name: identity.name || undefined,
        handle: identity.handle || undefined,
        avatar: identity.avatar || identity.avatarUrl || undefined,
      };
    }
  } catch {}
  return {};
}
