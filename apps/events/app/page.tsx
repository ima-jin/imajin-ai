import Link from 'next/link';
import { cookies } from 'next/headers';
import { db, events } from '@/src/db';
import { desc, eq, or, and, ne, isNull } from 'drizzle-orm';
import { ne } from 'drizzle-orm';

async function getViewerDid(): Promise<string | null> {
  const authUrl = process.env.AUTH_SERVICE_URL;
  if (!authUrl) return null;
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get('imajin_session');
    if (!session?.value) return null;
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `imajin_session=${session.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || null;
  } catch { return null; }
}

async function getEvents(viewerDid: string | null) {
  try {
    const publicStatuses = ['published', 'cancelled', 'completed'];
    // Hide invite-only events from non-owners (they can only access via direct link)
    const isPublicAccess = or(ne(events.accessMode, 'invite_only'), isNull(events.accessMode));
    const conditions = viewerDid
      ? or(
          and(or(...publicStatuses.map(s => eq(events.status, s))), isPublicAccess),
          // Owners always see their own events regardless of access mode
          and(eq(events.status, 'draft'), eq(events.creatorDid, viewerDid)),
          and(eq(events.status, 'paused'), eq(events.creatorDid, viewerDid)),
          and(or(...publicStatuses.map(s => eq(events.status, s))), eq(events.creatorDid, viewerDid))
        )
      : and(or(...publicStatuses.map(s => eq(events.status, s))), isPublicAccess);

    return await db
      .select()
      .from(events)
      .where(conditions)
      .orderBy(desc(events.startsAt))
      .limit(20);
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const viewerDid = await getViewerDid();
  const loggedIn = !!viewerDid;
  const eventList = await getEvents(viewerDid);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white">Events</h1>
          <p className="text-gray-400">
            Discover events on the sovereign network
          </p>
        </div>
        {loggedIn && (
          <Link
            href="/create"
            className="px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold"
          >
            Create Event
          </Link>
        )}
      </div>

      {eventList.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-xl font-semibold mb-2 text-white">No events yet</h2>
          <p className="text-gray-500 mb-6">
            {loggedIn ? 'Be the first to create an event!' : 'Check back soon for upcoming events.'}
          </p>
          {loggedIn && (
            <Link
              href="/create"
              className="inline-block px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition"
            >
              Create Event
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-6">
          {eventList.map((event) => {
            const isDimmed = event.status === 'cancelled' || event.status === 'completed';
            return (
            <Link
              key={event.id}
              href={`/${event.id}`}
              className={`bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-gray-700 transition${isDimmed ? ' opacity-60' : ''}`}
            >
              <div className="flex gap-6">
                {event.imageUrl && (
                  <img
                    src={event.imageUrl}
                    alt={event.title}
                    className="w-32 h-32 object-cover rounded-lg"
                  />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-xl font-bold text-white">{event.title}</h2>
                    {event.status === 'draft' && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-yellow-900/50 text-yellow-400 border border-yellow-700 rounded">
                        Draft
                      </span>
                    )}
                    {event.status === 'paused' && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-yellow-900/50 text-yellow-400 border border-yellow-700 rounded">
                        Paused
                      </span>
                    )}
                    {event.status === 'cancelled' && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-red-900/50 text-red-400 border border-red-700 rounded">
                        Cancelled
                      </span>
                    )}
                    {event.status === 'completed' && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-blue-900/50 text-blue-400 border border-blue-700 rounded">
                        Completed
                      </span>
                    )}
                  </div>
                  <p className="text-gray-400 mb-3 line-clamp-2">
                    {event.description}
                  </p>
                  <div className="flex gap-4 text-sm text-gray-500">
                    <span>
                      📅 {new Date(event.startsAt).toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    {event.city && <span>📍 {event.city}</span>}
                    {event.isVirtual && <span>💻 Virtual</span>}
                  </div>
                </div>
              </div>
            </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
