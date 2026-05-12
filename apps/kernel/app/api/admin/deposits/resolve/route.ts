import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const handle = searchParams.get('handle')?.trim();

  if (!handle) {
    return NextResponse.json({ error: 'Handle required' }, { status: 400 });
  }

  // Normalize: strip leading @ if present
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;

  const [row] = await sql`
    SELECT
      i.id AS did,
      i.handle,
      p.display_name
    FROM auth.identities i
    LEFT JOIN profile.profiles p ON p.did = i.id
    WHERE i.handle = ${normalized}
    LIMIT 1
  `;

  if (!row) {
    return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
  }

  return NextResponse.json({
    did: row.did as string,
    handle: row.handle as string | null,
    displayName: row.display_name as string | null,
  });
}
