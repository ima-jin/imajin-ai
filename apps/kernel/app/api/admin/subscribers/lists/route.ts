import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { randomUUID } from 'crypto';

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
}

export async function POST(req: NextRequest) {
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
}
