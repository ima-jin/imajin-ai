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

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  const [contact] = await sql`
    SELECT id FROM www.contacts WHERE id = ${id} LIMIT 1
  `;
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Unsubscribe all subscriptions then delete contact
  await sql`
    UPDATE www.subscriptions
    SET status = 'unsubscribed', unsubscribed_at = NOW()
    WHERE contact_id = ${id} AND status = 'subscribed'
  `;
  await sql`DELETE FROM www.contacts WHERE id = ${id}`;

  return NextResponse.json({ ok: true });
}
