import { getClient } from '@imajin/db';
import { requireAdmin } from '@imajin/logger';
import { redirect } from 'next/navigation';
import TraceView from './trace-view';

const sql = getClient();

export default async function AdminEventsTracePage({
  params,
}: {
  params: Promise<{ correlationId: string }>;
}) {
  const session = await requireAdmin();
  if (!session) {
    redirect('/');
  }

  const { correlationId } = await params;
  const decodedId = decodeURIComponent(correlationId);

  const events = await sql`
    SELECT id, service, action, did, correlation_id, parent_event_id, payload, status, duration_ms, created_at
    FROM registry.system_events
    WHERE correlation_id = ${decodedId}
    ORDER BY created_at ASC
  `;

  return <TraceView events={events as never} correlationId={decodedId} />;
}
