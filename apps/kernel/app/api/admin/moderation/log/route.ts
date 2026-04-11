import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

export const GET = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '25'));
  const offset = Number(url.searchParams.get('offset') ?? '0');

  const entries = await sql`
    SELECT m.*, p.display_name AS operator_name
    FROM registry.moderation_log m
    LEFT JOIN profile.profiles p ON m.operator_did = p.did
    ORDER BY m.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return NextResponse.json({ entries });
});
