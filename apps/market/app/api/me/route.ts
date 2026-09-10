import { NextRequest } from 'next/server';
import { requireAuth , resolveActingDid, resolveIdentitiesForDids } from '@imajin/auth';
import { jsonResponse } from '@/lib/utils';

/**
 * GET /api/me — Returns current authenticated user's identity, or null.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return jsonResponse({ did: null });
  }
  const { identity } = authResult;
  const did = resolveActingDid(identity);

  // If acting as a scope, resolve its display name via the kernel profile
  // service's batched /api/resolve route (#1998) — replaces the raw
  // cross-schema profiles-table read this app used to run directly (#2155).
  let scopeLabel: string | null = null;
  if (identity.actingAs) {
    const resolved = await resolveIdentitiesForDids([identity.actingAs]);
    const profile = resolved.get(identity.actingAs);
    scopeLabel = profile?.displayName || (profile?.handle ? `@${profile.handle}` : null);
  }

  return jsonResponse({ did, scopeLabel });
}
