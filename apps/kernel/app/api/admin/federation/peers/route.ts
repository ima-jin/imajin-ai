import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

export const GET = withLogger('kernel', async () => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const peers = await sql`
    SELECT peer_url, cursor, updated_at
    FROM relay.relay_peer_cursors
    ORDER BY updated_at DESC NULLS LAST
  `;

  return NextResponse.json({ peers });
});

export const POST = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const url = body?.url?.trim();
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }

  await sql`
    INSERT INTO relay.relay_peer_cursors (peer_url, cursor, updated_at)
    VALUES (${url}, '', NOW())
    ON CONFLICT (peer_url) DO NOTHING
  `;

  return NextResponse.json({ ok: true });
});

export const DELETE = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url).searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'url query param required' }, { status: 400 });
  }

  await sql`
    DELETE FROM relay.relay_peer_cursors WHERE peer_url = ${url}
  `;

  return NextResponse.json({ ok: true });
});
