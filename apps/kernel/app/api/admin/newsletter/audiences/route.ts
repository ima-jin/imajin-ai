import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

export const GET = withLogger('kernel', async (_req: NextRequest) => {
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
});
