import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, conversationsV2, conversationMembers } from '@/db';
import { requireAuth } from '@/lib/auth';
import { dmDid, conversationPath } from '@/lib/conversation-did';

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3007';

function redirect(path: string) {
  return NextResponse.redirect(`${APP_URL}${path}`);
}

/**
 * GET /start?did=DID
 * Finds or creates a v2 direct conversation with the given DID, then redirects to it.
 * Ensures both participants are in conversation_members.
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

  const myDid = authResult.identity.id;

  // Derive stable DM conversation DID
  const convDid = dmDid(myDid, did);

  // Upsert into conversations_v2 if it doesn't exist yet
  const existing = await db.query.conversationsV2.findFirst({
    where: eq(conversationsV2.did, convDid),
  });

  if (!existing) {
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
        memberDid: memberDid,
        role: 'participant',
      })
      .onConflictDoNothing();
  }

  return redirect(`/conversations/${conversationPath(convDid)}`);
}
