import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest, NextResponse } from 'next/server';
import { db, conversationReadsV2 } from '@/src/db';
import { sql } from 'drizzle-orm';

async function getSessionDid(req: NextRequest): Promise<string | null> {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  if (!cookie) return null;

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie.value}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/conversations/:id/read
 * Marks a v2 conversation as read.
 * :id is a URL-encoded conversation DID.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const did = await getSessionDid(req);
    if (!did) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const conversationDid = decodeURIComponent(id);

    await db
      .insert(conversationReadsV2)
      .values({
        conversationDid,
        did,
        lastReadAt: sql`NOW()`,
      })
      .onConflictDoUpdate({
        target: [conversationReadsV2.conversationDid, conversationReadsV2.did],
        set: { lastReadAt: sql`NOW()` },
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error marking conversation as read:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
