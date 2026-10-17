import { NextResponse, type NextRequest } from 'next/server';
import { and, arrayContains, eq, exists, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, channelLinks, pods, podMembers, registryApps } from '@/src/db';
import { verifyAppServiceToken } from '@/src/lib/auth/jwt';
import { APP_AUTHORIZATION_CHANNEL } from '@/src/lib/auth/app-authorization-grant';
import { corsHeaders } from '@/src/lib/kernel/cors';

const READ_SCOPE = 'connections:read';
const log = createLogger('kernel');

/** Service identity is never an owner DID supplied through a header or query. */
async function authenticate(request: NextRequest) {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return { error: 'App-service token required', status: 401 } as const;
  }
  const caller = await verifyAppServiceToken(header.slice(7));
  if (!caller) return { error: 'Invalid or expired app-service token', status: 401 } as const;
  if (!caller.scopes.includes(READ_SCOPE)) {
    return { error: 'connections:read scope required', status: 403 } as const;
  }

  // Like pay's app-service path, approvals and registration are live gates,
  // not merely mint-time checks. This scope is NOT globally service-eligible.
  const [app] = await db.select({ appDid: registryApps.appDid })
    .from(registryApps)
    .where(and(
      eq(registryApps.appDid, caller.appDid),
      eq(registryApps.status, 'active'),
      arrayContains(registryApps.approvedServiceScopes, [READ_SCOPE]),
    ))
    .limit(1);
  if (!app) return { error: 'App is not registered or approved for connections:read', status: 403 } as const;
  return { appDid: caller.appDid };
}

/** The owner's existing OAuth grant is the entitlement, not app registration. */
function ownerGrant(appDid: string) {
  return exists(db.select({ id: channelLinks.id }).from(channelLinks).where(and(
    eq(channelLinks.channel, APP_AUTHORIZATION_CHANNEL),
    eq(channelLinks.did, pods.ownerDid),
    eq(channelLinks.appDid, appDid),
    eq(channelLinks.status, 'active'),
    isNull(channelLinks.revokedAt),
    arrayContains(channelLinks.scopes, [READ_SCOPE]),
  )));
}

/** Both queries authorize inside SQL so reverse lookups cannot enumerate other owners. */
export async function readAppPodMembership(request: NextRequest, podId?: string) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const caller = await authenticate(request);
    if ('error' in caller) {
      return NextResponse.json({ error: caller.error }, { status: caller.status, headers });
    }
    if (podId !== undefined) {
      const rows = await db.select({
        podId: pods.id,
        did: podMembers.did,
        role: podMembers.role,
        joinedAt: podMembers.joinedAt,
      }).from(pods).leftJoin(podMembers, and(
        eq(podMembers.podId, pods.id),
        isNull(podMembers.removedAt),
      )).where(and(eq(pods.id, podId), ownerGrant(caller.appDid)));
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Pod not found' }, { status: 404, headers });
      }
      const members = rows.filter((row) => row.did !== null).map((row) => ({
        podId: row.podId, did: row.did, role: row.role, joinedAt: row.joinedAt,
      }));
      return NextResponse.json({ podId, members }, { headers });
    }

    const did = request.nextUrl.searchParams.get('did');
    if (!did?.startsWith('did:') || did.length > 2048 || did.trim() !== did) {
      return NextResponse.json({ error: 'A did query parameter is required' }, { status: 400, headers });
    }
    const rows = await db.select({ podId: pods.id })
      .from(pods).innerJoin(podMembers, eq(podMembers.podId, pods.id))
      .where(and(
        eq(podMembers.did, did),
        isNull(podMembers.removedAt),
        ownerGrant(caller.appDid),
      )).orderBy(pods.id);
    return NextResponse.json({ podIds: rows.map((row) => row.podId) }, { headers });
  } catch (err) {
    log.error({ err: String(err) }, 'App pod membership read failed');
    return NextResponse.json({ error: 'Pod membership unavailable' }, { status: 503, headers });
  }
}
