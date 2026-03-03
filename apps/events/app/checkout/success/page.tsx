import Link from 'next/link';
import { db, tickets, ticketTypes, events } from '@/src/db';
import { eq, desc } from 'drizzle-orm';

interface Props {
  searchParams: Promise<{ session_id?: string; event?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function SuccessPage({ searchParams }: Props) {
  const params = await searchParams;
  const eventId = params.event;

  // Try to find the event details
  let event: { id: string; title: string; startsAt: Date | null } | null = null;
  if (eventId) {
    const [found] = await db
      .select({ id: events.id, title: events.title, startsAt: events.startsAt })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    event = found || null;
  }

  return (
    <div className="max-w-2xl mx-auto text-center py-16 px-4">
      <div className="text-8xl mb-6">🟠</div>

      <h1 className="text-4xl font-bold mb-2">You've got a ticket!</h1>
      {event && (
        <p className="text-2xl text-orange-500 font-semibold mb-6">{event.title}</p>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 mb-8">
        <h2 className="font-semibold text-lg mb-4">Here's what's waiting for you:</h2>
        <ul className="text-left text-gray-600 dark:text-gray-400 space-y-3">
          <li className="flex items-start gap-3">
            <span className="text-xl">📧</span>
            <span><strong>Check your email</strong> — we sent a confirmation with a magic link to access everything</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-xl">💬</span>
            <span><strong>Join the conversation</strong> — there's a live chat where ticket holders are hanging out</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-xl">📋</span>
            <span><strong>Fill out the survey</strong> — if the organizer has questions, help them make this event great</span>
          </li>
        </ul>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 justify-center">
        {event ? (
          <Link
            href={`/${event.id}`}
            className="inline-block px-8 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-semibold text-lg"
          >
            Go to the Event →
          </Link>
        ) : (
          <Link
            href="/"
            className="inline-block px-8 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-semibold text-lg"
          >
            Browse Events
          </Link>
        )}
      </div>

      {params.session_id && (
        <p className="text-sm text-gray-500 mt-8">
          Order: {params.session_id.slice(0, 20)}...
        </p>
      )}
    </div>
  );
}
