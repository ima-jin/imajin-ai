import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@imajin/auth';
import { getClient } from '@imajin/db';

const sql = getClient();

async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) return null;
  const [nodeRow] = await sql`
    SELECT group_did FROM auth.group_identities
    WHERE group_did = ${session.actingAs}
    AND scope = 'node'
    LIMIT 1
  `;
  return nodeRow ? session : null;
}

export async function GET(_req: NextRequest) {
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
}
