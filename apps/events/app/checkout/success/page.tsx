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

  let event: { id: string; title: string; startsAt: Date | null; imageUrl: string | null } | null = null;
  if (eventId) {
    const [found] = await db
      .select({ id: events.id, title: events.title, startsAt: events.startsAt, imageUrl: events.imageUrl })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    event = found || null;
  }

  return (
    <div className="max-w-2xl mx-auto text-center py-8 px-4">
      {/* Hero banner with overlay */}
      <div className="relative -mx-4 sm:mx-0 sm:rounded-2xl overflow-hidden mb-8">
        {event?.imageUrl ? (
          <img
            src={event.imageUrl}
            alt={event.title}
            className="w-full h-[240px] md:h-[320px] object-cover"
          />
        ) : (
          <div className="w-full h-[240px] md:h-[320px] bg-gradient-to-br from-orange-500 to-amber-600" />
        )}
        <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">{"You've got a ticket!"}</h1>
          {event && (
            <p className="text-xl md:text-2xl text-orange-300 font-semibold">{event.title}</p>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 mb-8">
        <h2 className="font-semibold text-lg mb-4">{"Here's what's waiting for you:"}</h2>
        <ul className="text-left text-gray-600 dark:text-gray-400 space-y-3">
          <li className="flex items-start gap-3">
            <span className="text-xl">📧</span>
            <span><strong>Check your email</strong> — we sent a confirmation with a magic link to access everything</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-xl">💬</span>
            <span><strong>Join the conversation</strong> — {"there's"} a live chat where ticket holders are hanging out</span>
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
