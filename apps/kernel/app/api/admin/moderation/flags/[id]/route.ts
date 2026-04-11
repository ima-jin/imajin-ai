import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin } from '@imajin/logger';

const sql = getClient();

function genId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { status, resolution } = body ?? {};

  if (!status || !['dismissed', 'actioned'].includes(status)) {
    return NextResponse.json({ error: 'status must be dismissed or actioned' }, { status: 400 });
  }

  const [flag] = await sql`
    SELECT * FROM registry.flags WHERE id = ${id} LIMIT 1
  `;
  if (!flag) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await sql`
    UPDATE registry.flags
    SET status = ${status},
        resolved_at = NOW(),
        resolved_by = ${session.actingAs!},
        resolution = ${resolution ?? null}
    WHERE id = ${id}
  `;

  // Log to moderation_log
  const action = status === 'dismissed' ? 'dismiss_flag' : 'remove_content';
  const logId = genId('modlog');
  await sql`
    INSERT INTO registry.moderation_log (id, operator_did, action, target_did, target_type, target_id, reason, created_at)
    VALUES (
      ${logId},
      ${session.actingAs!},
      ${action},
      ${flag.target_did as string},
      ${flag.target_type as string},
      ${flag.target_id as string},
      ${resolution ?? null},
      NOW()
    )
  `;

  return NextResponse.json({ ok: true });
}
