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

export async function GET(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const listSlug = searchParams.get('list') ?? '';

  const conditions: string[] = [];
  const binds: string[] = [];
  let idx = 1;

  if (listSlug) {
    conditions.push(`ml.slug = $${idx}`);
    binds.push(listSlug);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await sql.unsafe(
    `SELECT
       c.email,
       c.source,
       c.is_verified,
       c.verified_at,
       s.status,
       s.subscribed_at,
       ml.slug AS list_slug,
       ml.name AS list_name
     FROM www.contacts c
     JOIN www.subscriptions s ON c.id = s.contact_id
     JOIN www.mailing_lists ml ON ml.id = s.mailing_list_id
     ${whereClause}
     ORDER BY s.subscribed_at DESC`,
    binds
  );

  const header = 'email,source,is_verified,verified_at,status,subscribed_at,list_slug,list_name\n';
  const csvRows = rows.map((r) => {
    const fields = [
      r.email,
      r.source,
      r.is_verified ? 'true' : 'false',
      r.verified_at ? new Date(r.verified_at as string).toISOString() : '',
      r.status,
      r.subscribed_at ? new Date(r.subscribed_at as string).toISOString() : '',
      r.list_slug,
      `"${String(r.list_name).replace(/"/g, '""')}"`,
    ];
    return fields.join(',');
  });

  const csv = header + csvRows.join('\n');
  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename=subscribers-${date}.csv`,
    },
  });
}
