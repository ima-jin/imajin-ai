import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

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
