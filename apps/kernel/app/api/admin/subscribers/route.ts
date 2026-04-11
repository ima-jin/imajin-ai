import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

const PAGE_SIZE = 25;

export const GET = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() ?? '';
  const verified = searchParams.get('verified');
  const listSlug = searchParams.get('list') ?? '';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const offset = (page - 1) * PAGE_SIZE;

  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`c.email ILIKE $${idx}`);
    binds.push(`%${q}%`);
    idx++;
  }
  if (verified === 'true') {
    conditions.push(`c.is_verified = TRUE`);
  } else if (verified === 'false') {
    conditions.push(`c.is_verified = FALSE`);
  }
  if (listSlug) {
    conditions.push(`ml.slug = $${idx}`);
    binds.push(listSlug);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = await sql.unsafe(
    `SELECT COUNT(*) AS total
     FROM www.contacts c
     JOIN www.subscriptions s ON c.id = s.contact_id
     JOIN www.mailing_lists ml ON ml.id = s.mailing_list_id
     ${whereClause}`,
    binds as string[]
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await sql.unsafe(
    `SELECT
       c.id,
       c.email,
       c.source,
       c.is_verified,
       c.verified_at,
       c.created_at,
       s.status,
       s.subscribed_at,
       ml.slug AS list_slug,
       ml.name AS list_name
     FROM www.contacts c
     JOIN www.subscriptions s ON c.id = s.contact_id
     JOIN www.mailing_lists ml ON ml.id = s.mailing_list_id
     ${whereClause}
     ORDER BY s.subscribed_at DESC
     LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    binds as string[]
  );

  return NextResponse.json({ subscribers: rows, total, page, pageSize: PAGE_SIZE });
});
