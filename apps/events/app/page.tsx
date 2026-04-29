import Link from 'next/link';
import { cookies } from 'next/headers';
import { createLogger } from '@imajin/logger';

const log = createLogger('events');
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { db, events } from '@/src/db';
import { desc, eq, or, and, ne, isNull, inArray } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { getLocationType } from '@/src/lib/location';

/** Strip markdown syntax to get clean plaintext for excerpts */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')     // ![alt](url) → remove
    .replace(/[*_~`#>]+/g, '')                   // remove emphasis/heading markers
    .replace(/\n{2,}/g, ' · ')                   // paragraph breaks → separator
    .replace(/\n/g, ' ')                          // line breaks → space
    .replace(/\s+/g, ' ')                         // collapse whitespace
    .trim();
}

const sql = getClient();

async function getViewerDid(): Promise<string | null> {
  const authUrl = process.env.AUTH_SERVICE_URL;
  if (!authUrl) return null;
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get(SESSION_COOKIE_NAME);
    if (!session?.value) return null;
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.value}` },
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
    const isPublicAccess = or(ne(events.accessMode, 'invite_only'), isNull(events.accessMode));

    // Find event IDs where viewer is a cohost or has a ticket
    let cohostEventIds: string[] = [];
    let ticketEventIds: string[] = [];
    if (viewerDid) {
      const cohostRows = await sql`
        SELECT DISTINCT pm.pod_id, e.id as event_id
        FROM connections.pod_members pm
        JOIN events.events e ON e.pod_id = pm.pod_id
        WHERE pm.did = ${viewerDid} AND pm.role IN ('owner', 'cohost') AND pm.removed_at IS NULL
      `;
      cohostEventIds = cohostRows.map((r: any) => r.event_id);

      const ticketRows = await sql`
        SELECT DISTINCT event_id FROM events.tickets
        WHERE owner_did = ${viewerDid} AND status != 'cancelled'
      `;
      ticketEventIds = ticketRows.map((r: any) => r.event_id);
    }

    const accessibleEventIds = [...new Set([...cohostEventIds, ...ticketEventIds])];

    const conditions = viewerDid
      ? or(
          // Public events
          and(or(...publicStatuses.map(s => eq(events.status, s))), isPublicAccess),
          // Creator sees all their events
          and(eq(events.status, 'draft'), eq(events.creatorDid, viewerDid)),
          and(eq(events.status, 'paused'), eq(events.creatorDid, viewerDid)),
          and(or(...publicStatuses.map(s => eq(events.status, s))), eq(events.creatorDid, viewerDid)),
          // Cohosts and ticket holders see invite-only events
          ...(accessibleEventIds.length > 0
            ? [and(or(...publicStatuses.map(s => eq(events.status, s))), inArray(events.id, accessibleEventIds))]
            : [])
        )
      : and(or(...publicStatuses.map(s => eq(events.status, s))), isPublicAccess);

    const results = await db
      .select()
      .from(events)
      .where(conditions)
      .orderBy(desc(events.startsAt))
      .limit(20);

    return { events: results, cohostEventIds, ticketEventIds };
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to fetch events');
    return { events: [], cohostEventIds: [], ticketEventIds: [] };
  }
}

export default async function HomePage() {
  const viewerDid = await getViewerDid();
  const loggedIn = !!viewerDid;
  const { events: eventList, cohostEventIds, ticketEventIds } = await getEvents(viewerDid);

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
                    {cohostEventIds.includes(event.id) && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-orange-900/50 text-orange-400 border border-orange-700 rounded">
                        Cohost
                      </span>
                    )}
                    {ticketEventIds.includes(event.id) && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-green-900/50 text-green-400 border border-green-700 rounded">
                        🎫 Attending
                      </span>
                    )}
                  </div>
                  {event.description && (
                    <p className="text-gray-400 mb-3 line-clamp-2">
                      {stripMarkdown(event.description)}
                    </p>
                  )}
                  <div className="flex gap-4 text-sm text-gray-500">
                    <span>
                      📅 {new Date(event.startsAt).toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    {event.city && <span>📍 {event.city}</span>}
                    {getLocationType(event) === 'virtual' && <span>💻 Virtual</span>}
                    {getLocationType(event) === 'hybrid' && <span>💻📍 Hybrid</span>}
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
