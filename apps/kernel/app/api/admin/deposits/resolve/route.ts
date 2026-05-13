import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * GET /api/admin/deposits/resolve?handle=xxx
 * Resolve a handle to a DID + display name.
 */
export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const handle = request.nextUrl.searchParams.get('handle')?.trim();
  if (!handle) {
    return NextResponse.json({ error: 'handle query param is required' }, { status: 400 });
  }

  const rows = await sql`
    SELECT
      i.did,
      i.handle,
      p.display_name
    FROM auth.identities i
    LEFT JOIN profile.profiles p ON p.did = i.did
    WHERE LOWER(i.handle) = LOWER(${handle})
    LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
  }

  const row = rows[0];
  return NextResponse.json({
    did: row.did,
    handle: row.handle,
    displayName: row.display_name || null,
  });
}
