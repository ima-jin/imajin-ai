import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

export const GET = withLogger('kernel', async (_req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sends = await sql`
    SELECT id, subject, audience_type, audience_id, recipient_count, sent_at
    FROM registry.newsletter_sends
    WHERE sender_did = ${session.actingAs}
    ORDER BY sent_at DESC
    LIMIT 20
  `;

  return NextResponse.json({ sends });
});
