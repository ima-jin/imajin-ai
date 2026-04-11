import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

function genId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

export const GET = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const status = new URL(req.url).searchParams.get('status') ?? 'pending';

  const flags = await sql`
    SELECT f.*, p.display_name AS reporter_name
    FROM registry.flags f
    LEFT JOIN profile.profiles p ON f.reporter_did = p.did
    WHERE f.status = ${status}
    ORDER BY f.created_at DESC
  `;

  return NextResponse.json({ flags });
});

export const POST = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const { targetDid, targetType, targetId, reason } = body ?? {};

  if (!targetDid || !targetType || !targetId || !reason) {
    return NextResponse.json({ error: 'targetDid, targetType, targetId, reason are required' }, { status: 400 });
  }

  const id = genId('flag');
  const reporterDid = session.actingAs!;

  await sql`
    INSERT INTO registry.flags (id, reporter_did, target_did, target_type, target_id, reason, status, created_at)
    VALUES (${id}, ${reporterDid}, ${targetDid}, ${targetType}, ${targetId}, ${reason}, 'pending', NOW())
  `;

  return NextResponse.json({ ok: true, id });
});
