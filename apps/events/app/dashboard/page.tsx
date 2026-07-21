import { redirect } from 'next/navigation';
import { getSession , resolveActingDid } from '@imajin/auth';
import { db, events, ticketTypes } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import Link from 'next/link';
import { PayoutSetupBanner } from '@imajin/ui';
import { buildPublicUrl } from '@imajin/config';

const PAY_URL = buildPublicUrl('pay');
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
    const authUrl = buildPublicUrl('auth');
    const eventsUrl = buildPublicUrl('events');
    const dashboardUrl = `${eventsUrl}/dashboard`;
    redirect(`${authUrl}/login?next=${encodeURIComponent(dashboardUrl)}`);
  }

  const did = resolveActingDid(session);

  // Resolve scope name for acting-as context
  let scopeLabel: string | null = null;
  if (session.actingAs) {
    const sql = getClient();
    const [profile] = await sql`SELECT display_name, handle FROM profile.profiles WHERE did = ${session.actingAs} LIMIT 1`.catch(() => []);
    scopeLabel = profile?.display_name || (profile?.handle ? `@${profile.handle}` : null);
  }

  const userEvents = await db.select().from(events).where(eq(events.creatorDid, did)).orderBy(desc(events.createdAt));
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
      <PayoutSetupBanner
        did={did}
        payUrl={PAY_URL}
        message="Connect your bank account to receive ticket revenue"
      />
      {/* Header */}
      <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold mb-2">{scopeLabel ? `${scopeLabel}'s Events` : 'My Events'}</h1>
          <p className="text-gray-500 dark:text-gray-400">
            {scopeLabel ? `Manage events for ${scopeLabel}` : 'Manage your events and track ticket sales'}
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
            <h2 className="text-2xl font-bold mb-3">No events yet</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Create your first event to start bringing people together, sell tickets, and build your community.
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
