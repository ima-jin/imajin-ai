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
    SELECT p.peer_url, p.push, p.fetch, p.sync, p.enabled, p.label, p.created_at,
           c.cursor, c.updated_at AS last_synced
    FROM relay.relay_peers p
    LEFT JOIN relay.relay_peer_cursors c ON c.peer_url = p.peer_url
    ORDER BY p.created_at ASC
  `;

  return NextResponse.json({ peers });
});

export const POST = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.peerUrl || typeof body.peerUrl !== 'string') {
    return NextResponse.json({ error: 'peerUrl is required' }, { status: 400 });
  }

  const peerUrl = body.peerUrl.trim().replace(/\/+$/, '');
  if (!peerUrl.startsWith('http://') && !peerUrl.startsWith('https://')) {
    return NextResponse.json({ error: 'peerUrl must be an HTTP(S) URL' }, { status: 400 });
  }

  const label = body.label?.trim() || null;
  const push = body.push ?? 1;
  const fetch_ = body.fetch ?? 1;
  const sync = body.sync ?? 1;

  await sql`
    INSERT INTO relay.relay_peers (peer_url, push, fetch, sync, enabled, label)
    VALUES (${peerUrl}, ${push ? 1 : 0}, ${fetch_ ? 1 : 0}, ${sync ? 1 : 0}, 1, ${label})
    ON CONFLICT (peer_url) DO UPDATE
    SET push = EXCLUDED.push,
        fetch = EXCLUDED.fetch,
        sync = EXCLUDED.sync,
        label = EXCLUDED.label
  `;

  return NextResponse.json({ ok: true, peerUrl });
});

export const DELETE = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const peerUrl = searchParams.get('peerUrl');
  if (!peerUrl) {
    return NextResponse.json({ error: 'peerUrl query param required' }, { status: 400 });
  }

  await sql`DELETE FROM relay.relay_peers WHERE peer_url = ${peerUrl}`;
  await sql`DELETE FROM relay.relay_peer_cursors WHERE peer_url = ${peerUrl}`;

  return NextResponse.json({ ok: true });
});

export const PATCH = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.peerUrl) {
    return NextResponse.json({ error: 'peerUrl is required' }, { status: 400 });
  }

  if (body.enabled !== undefined) {
    await sql`
      UPDATE relay.relay_peers SET enabled = ${body.enabled ? 1 : 0}
      WHERE peer_url = ${body.peerUrl}
    `;
  }
  if (body.push !== undefined) {
    await sql`
      UPDATE relay.relay_peers SET push = ${body.push ? 1 : 0}
      WHERE peer_url = ${body.peerUrl}
    `;
  }
  if (body.fetch !== undefined) {
    await sql`
      UPDATE relay.relay_peers SET fetch = ${body.fetch ? 1 : 0}
      WHERE peer_url = ${body.peerUrl}
    `;
  }
  if (body.sync !== undefined) {
    await sql`
      UPDATE relay.relay_peers SET sync = ${body.sync ? 1 : 0}
      WHERE peer_url = ${body.peerUrl}
    `;
  }
  if (body.label !== undefined) {
    await sql`
      UPDATE relay.relay_peers SET label = ${body.label || null}
      WHERE peer_url = ${body.peerUrl}
    `;
  }

  return NextResponse.json({ ok: true });
});
