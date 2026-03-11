import { redirect } from 'next/navigation';
import { getSession } from '@/src/lib/auth';
import { db, events, ticketTypes } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { EventCard } from './event-card';

interface EventWithStats {
  id: string;
  title: string;
  startsAt: Date;
  imageUrl: string | null;
  status: string;
  statusBadge: string;
  ticketsSold: number;
  revenue: number;
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
    const eventsUrl = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
    redirect(`${authUrl}/login?next=${encodeURIComponent(`${eventsUrl}/dashboard`)}`);
  }

  const userEvents = await db.select().from(events).where(eq(events.creatorDid, session.id)).orderBy(desc(events.createdAt));
  const eventsWithStats = await Promise.all(userEvents.map(async (event) => {
    const types = await db.select().from(ticketTypes).where(eq(ticketTypes.eventId, event.id));
    const totalTicketsSold = types.reduce((sum, t) => sum + (t.sold || 0), 0);
    const totalRevenue = types.reduce((sum, t) => sum + (t.sold || 0) * t.price, 0);
    let statusBadge = event.status;
    const now = new Date();
    if (event.status === 'published') {
      statusBadge = new Date(event.startsAt) < now ? 'past' : 'live';
    }
    return { ...event, ticketsSold: totalTicketsSold, revenue: totalRevenue, statusBadge, ticketTypes: types };
  }));

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold mb-2">My Events</h1>
          <p className="text-gray-500 dark:text-gray-400">
            Manage your events and track ticket sales
          </p>
        </div>
        <Link
          href="/create"
          className="inline-flex items-center justify-center px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Event
        </Link>
      </div>

      {/* Events Grid or Empty State */}
      {eventsWithStats.length === 0 ? (
        <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg p-12 text-center">
          <div className="max-w-md mx-auto">
            <div className="text-6xl mb-4">🎉</div>
            <h2 className="text-2xl font-bold mb-3">Create your first event</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Start bringing people together. Create an event, sell tickets, and build your community.
            </p>
            <Link
              href="/create"
              className="inline-flex items-center justify-center px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition-colors"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create Event
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {eventsWithStats.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
