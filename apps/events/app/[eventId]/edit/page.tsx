import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/src/lib/auth';
import { db, events, ticketTypes } from '@/src/db';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import EventEditForm from './form';

const sql = getClient();

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ eventId: string }>;
}

async function getEvent(eventId: string) {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return event;
}

async function getTicketTypes(eventId: string) {
  return db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(ticketTypes.sortOrder);
}

export default async function EditEventPage({ params }: Props) {
  const session = await getSession();
  const { eventId } = await params;

  if (!session) {
    redirect(`https://auth.imajin.ai/login?next=https://events.imajin.ai/${eventId}/edit`);
  }

  const event = await getEvent(eventId);

  if (!event) {
    notFound();
  }

  // Check authorization - creator or cohost can edit
  let isOrganizer = event.creatorDid === session.id;
  if (!isOrganizer && event.podId) {
    try {
      const [member] = await sql`
        SELECT did FROM connections.pod_members
        WHERE pod_id = ${event.podId} AND did = ${session.id} AND role = 'cohost' AND removed_at IS NULL
        LIMIT 1
      `;
      isOrganizer = !!member;
    } catch {}
  }
  if (!isOrganizer) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-6 text-center">
          <div className="text-5xl mb-4">🚫</div>
          <h1 className="text-2xl font-bold mb-2">Not Authorized</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            You don't have permission to edit this event.
          </p>
          <a
            href={`/${eventId}`}
            className="inline-block px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
          >
            View Event
          </a>
        </div>
      </div>
    );
  }

  const tickets = await getTicketTypes(eventId);

  // Fetch creator profile email for EMT auto-fill
  let creatorEmail: string | null = null;
  try {
    const [profile] = await sql`SELECT email FROM profile.profiles WHERE did = ${event.creatorDid}`;
    creatorEmail = profile?.email || null;
  } catch {}

  return (
    <div className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold mb-2">Edit Event</h1>
            <a
              href={`/${eventId}`}
              className="text-sm text-orange-500 hover:text-orange-600 font-medium flex items-center gap-1"
            >
              ← View Live Event
            </a>
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            Update your event details
          </p>
        </div>

        <EventEditForm event={event} existingTickets={tickets} creatorEmail={creatorEmail} />
      </div>
    </div>
  );
}
