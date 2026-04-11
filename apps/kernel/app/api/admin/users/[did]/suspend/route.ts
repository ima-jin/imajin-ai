import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin } from '@imajin/logger';

const sql = getClient();

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  const [identity] = await sql`
    SELECT id, suspended_at FROM auth.identities WHERE id = ${decodedDid} LIMIT 1
  `;
  if (!identity) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const isSuspended = !!identity.suspended_at;

  if (isSuspended) {
    await sql`
      UPDATE auth.identities
      SET suspended_at = NULL, updated_at = NOW()
      WHERE id = ${decodedDid}
    `;
  } else {
    await sql`
      UPDATE auth.identities
      SET suspended_at = NOW(), updated_at = NOW()
      WHERE id = ${decodedDid}
    `;
  }

  return NextResponse.json({ ok: true, suspended: !isSuspended });
}
