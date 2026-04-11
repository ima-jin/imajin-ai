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

export async function GET(_req: NextRequest) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const lists = await sql`
    SELECT
      ml.id,
      ml.name,
      ml.slug,
      COUNT(s.id) FILTER (WHERE s.status = 'subscribed') AS subscriber_count
    FROM www.mailing_lists ml
    LEFT JOIN www.subscriptions s ON s.mailing_list_id = ml.id
    WHERE ml.owner_did IS NULL OR ml.owner_did = ${session.actingAs}
    GROUP BY ml.id
    ORDER BY ml.created_at ASC
  `;

  const [connRow] = await sql`
    SELECT COUNT(*) AS total
    FROM connections.connections
    WHERE (did_a = ${session.actingAs} OR did_b = ${session.actingAs})
    AND disconnected_at IS NULL
  `;
  const connectionCount = Number(connRow?.total ?? 0);

  return NextResponse.json({ lists, connectionCount });
}
