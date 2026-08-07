import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, conversationsV2, conversationMembers } from '@/src/db';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { dmDid, conversationPath } from '@/src/lib/chat/conversation-did';
import { canInitiateDm, DM_CONNECTION_REQUIRED } from '@/src/lib/chat/connection-check';
import { buildPublicUrl } from '@imajin/config';

const APP_URL = buildPublicUrl('chat');

function redirect(path: string) {
  return NextResponse.redirect(`${APP_URL}${path}`);
}

/**
 * GET /start?did=DID
 * Finds or creates a v2 direct conversation with the given DID, then redirects to it.
 * Ensures both participants are in conversation_members.
 *
 * Opening a NEW thread requires an active connection with the target, or that
 * the target is an agent (#855). An existing thread is always reachable.
 *
 * Cognitive complexity: 6 (≤ 15)
 */
export async function GET(request: NextRequest) {
  const did = request.nextUrl.searchParams.get('did');
  if (!did) {
    return redirect('/conversations');
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return redirect('/conversations');
  }

  const myDid = resolveActingDid(authResult.identity);

  // Derive stable DM conversation DID
  const convDid = dmDid(myDid, did);

  // Upsert into conversations_v2 if it doesn't exist yet
  const existing = await db.query.conversationsV2.findFirst({
    where: eq(conversationsV2.did, convDid),
  });

  if (!existing) {
    const allowed = await canInitiateDm(myDid, did);
    if (!allowed) {
      return NextResponse.json({ error: DM_CONNECTION_REQUIRED }, { status: 403 });
    }

    await db
      .insert(conversationsV2)
      .values({
        did: convDid,
        createdBy: myDid,
      })
      .onConflictDoNothing();
  }

  // Ensure both participants are in conversation_members
  for (const memberDid of [myDid, did]) {
    await db
      .insert(conversationMembers)
      .values({
        conversationDid: convDid,
        memberDid,
        role: 'participant',
      })
      .onConflictDoNothing();
  }

  return redirect(`/conversations/${conversationPath(convDid)}`);
}
