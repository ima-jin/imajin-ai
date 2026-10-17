import { NextRequest } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, conversationsV2, identities } from '@/src/db';
import { authenticatePayApp as authenticateRegisteredApp } from '@/src/lib/pay/app-service-auth';
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

/**
 * PUT /chat/api/d/:did — create or rename an app-owned event conversation.
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
      return errorResponse('Valid event DID, name (1–200 characters), and createdBy are required', 400, cors);
    }
    const { name, createdBy } = body.data;
    const denied = await authorizeCreator(request, auth.appDid, createdBy);
    if (denied) return errorResponse(denied.error, denied.status, cors);

    const [event] = await db.select({ did: identities.id }).from(identities).where(and(
      eq(identities.id, did),
      eq(identities.subtype, 'event'),
      isNull(identities.suspendedAt),
    )).limit(1);
    if (!event) return errorResponse('Active event identity not found', 404, cors);

    // One atomic statement: a conflicting app/owner/legacy row cannot be adopted,
    // even if competing requests race. Context and membership grant no authority.
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
  } catch {
    log.error({}, 'App conversation metadata update failed');
    return errorResponse('Failed to update conversation metadata', 500, cors);
  }
}
