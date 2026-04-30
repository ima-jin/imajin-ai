import { NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { getClient } from '@imajin/db';
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
  const did = identity.actingAs || identity.id;

  // If acting as a scope, resolve its display name
  let scopeLabel: string | null = null;
  if (identity.actingAs) {
    const sql = getClient();
    const [profile] = await sql`SELECT display_name, handle FROM profile.profiles WHERE did = ${identity.actingAs} LIMIT 1`.catch(() => []);
    scopeLabel = profile?.display_name || (profile?.handle ? `@${profile.handle}` : null);
  }

  return jsonResponse({ did, scopeLabel });
}
