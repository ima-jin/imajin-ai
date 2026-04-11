import { getClient } from '@imajin/db';
import { getSession } from '@imajin/auth';
import { redirect } from 'next/navigation';
import NewsletterComposer from './composer';

const sql = getClient();

async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) redirect('/admin');
  const [nodeRow] = await sql`
    SELECT group_did FROM auth.group_identities
    WHERE group_did = ${session.actingAs}
    AND scope = 'node'
    LIMIT 1
  `;
  if (!nodeRow) redirect('/admin');
  return session;
}

export default async function AdminNewsletterPage() {
  const session = await requireAdmin();

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

  const recentSends = await sql`
    SELECT id, subject, audience_type, audience_id, recipient_count, sent_at
    FROM registry.newsletter_sends
    WHERE sender_did = ${session.actingAs}
    ORDER BY sent_at DESC
    LIMIT 20
  `;

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Newsletter</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Compose and send newsletters to subscribers or connections
        </p>
      </div>

      <NewsletterComposer
        initialLists={lists.map((l) => ({
          id: l.id as string,
          name: l.name as string,
          slug: l.slug as string,
          subscriber_count: Number(l.subscriber_count),
        }))}
        initialConnectionCount={connectionCount}
        recentSends={recentSends.map((s) => ({
          id: s.id as string,
          subject: s.subject as string,
          audience_type: s.audience_type as string,
          audience_id: s.audience_id as string | null,
          recipient_count: Number(s.recipient_count),
          sent_at: s.sent_at ? new Date(s.sent_at as string).toISOString() : '',
        }))}
      />
    </div>
  );
}
