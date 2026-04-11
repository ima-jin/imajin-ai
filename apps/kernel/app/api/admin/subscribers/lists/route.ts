import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { randomUUID } from 'crypto';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

export const GET = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const lists = await sql`
    SELECT
      ml.id,
      ml.slug,
      ml.name,
      ml.description,
      ml.is_active,
      ml.owner_did,
      ml.created_at,
      COUNT(s.id) FILTER (WHERE s.status = 'subscribed') AS subscriber_count
    FROM www.mailing_lists ml
    LEFT JOIN www.subscriptions s ON s.mailing_list_id = ml.id
    WHERE ml.owner_did IS NULL OR ml.owner_did = ${session.actingAs}
    GROUP BY ml.id
    ORDER BY ml.created_at ASC
  `;

  return NextResponse.json({ lists });
});

export const POST = withLogger('kernel', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { name, slug, description } = body as { name: string; slug: string; description?: string };

  if (!name || !slug) return NextResponse.json({ error: 'name and slug are required' }, { status: 400 });

  const id = randomUUID();
  await sql`
    INSERT INTO www.mailing_lists (id, slug, name, description, is_active, owner_did)
    VALUES (${id}, ${slug}, ${name}, ${description ?? null}, TRUE, ${session.actingAs})
  `;

  return NextResponse.json({ ok: true, id });
});
