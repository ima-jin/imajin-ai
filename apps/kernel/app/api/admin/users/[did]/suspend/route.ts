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
