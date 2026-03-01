import { NextRequest, NextResponse } from 'next/server';
import { eq, and, or } from 'drizzle-orm';
import { db, conversations, participants } from '@/db';
import { requireAuth } from '@/lib/auth';

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3007';

function redirect(path: string) {
  return NextResponse.redirect(`${APP_URL}${path}`);
}

/**
 * GET /start?did=DID
 * Finds or creates a direct conversation with the given DID, then redirects to it.
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

  // Find existing direct conversation between these two DIDs
  const allParticipations = await db
    .select()
    .from(conversations)
    .innerJoin(participants, eq(participants.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.type, 'direct'),
        or(
          eq(participants.did, myDid),
          eq(participants.did, did)
        )
      )
    );

  // Group by conversation and find one with both DIDs
  const convCounts: Record<string, Set<string>> = {};
  for (const row of allParticipations) {
    const convId = row.chat_conversations.id;
    if (!convCounts[convId]) convCounts[convId] = new Set();
    convCounts[convId].add(row.chat_participants.did);
  }

  for (const [convId, dids] of Object.entries(convCounts)) {
    if (dids.has(myDid) && dids.has(did)) {
      return redirect(`/conversations/${convId}`);
    }
  }

  // No existing conversation — create one
  const { generateId } = await import('@/lib/utils');
  const conversationId = generateId('conv');

  await db.insert(conversations).values({
    id: conversationId,
    type: 'direct',
    createdBy: myDid,
  });

  await db.insert(participants).values([
    { conversationId, did: myDid, role: 'owner' },
    { conversationId, did, role: 'member', invitedBy: myDid },
  ]);

  return redirect(`/conversations/${conversationId}`);
}
