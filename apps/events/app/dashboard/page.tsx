import { redirect } from 'next/navigation';
import { getSession } from '@/src/lib/auth';
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

async function getMyEvents(): Promise<EventWithStats[]> {
  const baseUrl = process.env.NEXT_PUBLIC_EVENTS_URL || 'http://localhost:3004';

  try {
    const response = await fetch(`${baseUrl}/api/events/mine`, {
      cache: 'no-store',
      headers: {
        // Forward cookies from the server-side request
        Cookie: (await import('next/headers')).cookies().toString(),
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.events || [];
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return [];
  }
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect('https://auth.imajin.ai/login?next=https://events.imajin.ai/dashboard');
  }

  const events = await getMyEvents();

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
      {events.length === 0 ? (
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
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
