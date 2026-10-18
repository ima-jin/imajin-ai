import { NextRequest } from 'next/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, conversationsV2, identities, identityMembers } from '@/src/db';
import { authenticatePayApp as authenticateRegisteredApp } from '@/src/lib/kernel/app-service-auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { errorResponse, isValidDid, jsonResponse } from '@/src/lib/kernel/utils';

export const dynamic = 'force-dynamic';
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

const log = createLogger('kernel:chat');
const metadataSchema = z.object({
  name: z.string().trim().min(1).max(200),
  createdBy: z.string().refine(isValidDid),
}).strict();

/** App-service authority is not permission to impersonate a human creator. */
async function authorizeCreator(request: NextRequest, appDid: string, createdBy: string) {
  if (createdBy === appDid) return null;
  const auth = await requireAuth(request, { sessionOnly: true, service: 'chat' });
  if ('error' in auth) return auth;
  return resolveActingDid(auth.identity) === createdBy
    ? null
    : { error: 'createdBy must match the authenticated acting identity', status: 403 };
}

/** Identity authority is checked before room existence, including for legacy identities. */
async function authorizeIdentity(request: NextRequest, did: string, appDid: string, createdBy: string) {
  const denied = { error: 'Identity is not managed by this app or creator', status: 403 };
  const [identity] = await db.select({
    registeredByAppDid: identities.registeredByAppDid,
  }).from(identities).where(and(
    eq(identities.id, did), isNull(identities.suspendedAt),
  )).limit(1);
  if (!identity) return denied;
  if (identity.registeredByAppDid === appDid) return null;

  const members = await db.select({ did: identityMembers.memberDid }).from(identityMembers).where(and(
    eq(identityMembers.identityDid, did),
    inArray(identityMembers.memberDid, [appDid, createdBy]),
    inArray(identityMembers.role, ['owner', 'admin']),
    isNull(identityMembers.removedAt),
  ));
  if (members.some((member) => member.did === appDid)) return null;
  if (members.some((member) => member.did === createdBy)) {
    return authorizeCreator(request, appDid, createdBy);
  }
  return denied;
}

/**
 * PUT /chat/api/d/:did — create or rename an app-owned identity conversation.
 * Must run before member sync. Existing unbound rooms are never claimable.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> },
) {
  const cors = corsHeaders(request);
  try {
    const auth = await authenticateRegisteredApp(request, 'chat:write');
    if ('error' in auth) return errorResponse(auth.error, auth.status, cors);

    const body = metadataSchema.safeParse(await request.json().catch(() => null));
    const { did } = await params;
    if (!isValidDid(did) || !body.success) {
      return errorResponse('Valid identity DID, name (1–200 characters), and createdBy are required', 400, cors);
    }
    const { name, createdBy } = body.data;
    const identityDenied = await authorizeIdentity(request, did, auth.appDid, createdBy);
    if (identityDenied) return errorResponse(identityDenied.error, identityDenied.status, cors);
    const [existing] = await db.select({
      appDid: conversationsV2.appDid, createdBy: conversationsV2.createdBy,
    }).from(conversationsV2).where(eq(conversationsV2.did, did)).limit(1);
    if (existing && (existing.appDid !== auth.appDid || existing.createdBy !== createdBy)) {
      return errorResponse('Conversation is not owned by this app and creator', 403, cors);
    }
    if (!existing) {
      const denied = await authorizeCreator(request, auth.appDid, createdBy);
      if (denied) return errorResponse(denied.error, denied.status, cors);
    }

    // One atomic statement: a conflicting app/owner/legacy row cannot be adopted,
    // even if competing requests race. Context and chat membership grant no authority.
    const [conversation] = await db.insert(conversationsV2).values({
      did, type: 'group', name, createdBy, appDid: auth.appDid,
    }).onConflictDoUpdate({
      target: conversationsV2.did,
      set: { name, updatedAt: new Date() },
      setWhere: and(
        eq(conversationsV2.appDid, auth.appDid),
        eq(conversationsV2.createdBy, createdBy),
      ),
    }).returning({
      did: conversationsV2.did,
      name: conversationsV2.name,
      createdBy: conversationsV2.createdBy,
      appDid: conversationsV2.appDid,
    });
    if (!conversation) return errorResponse('Conversation is not owned by this app and creator', 403, cors);
    return jsonResponse({ conversation }, 200, cors);
  } catch (err) {
    log.error({
      message: err instanceof Error ? err.message : 'Unknown error',
      code: err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined,
    }, 'App conversation metadata update failed');
    return errorResponse('Failed to update conversation metadata', 500, cors);
  }
}
