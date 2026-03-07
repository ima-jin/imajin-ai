import { notFound } from 'next/navigation';
import Link from 'next/link';
import { db, events, ticketTypes, tickets, eventInvites } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { TicketsSection } from './tickets-section';
import { generateQRCode } from '@/src/lib/email';
import { getClient } from '@imajin/db';

const sql = getClient();

export const revalidate = 0; // always fresh — event data changes frequently during editing
import { Countdown } from './countdown';
import { EventLobbyAccordion } from './event-lobby-accordion';
import { EventSurveyAccordion } from './event-survey-accordion';
import { FairAccordion } from '@imajin/fair';
import { TicketsGate } from './tickets-gate';
import { ShareButton } from './share-button';
import { getSession } from '@/src/lib/auth';
import { MarkdownContent } from '@imajin/ui';
import type { Metadata } from 'next';

interface Props {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ invite?: string }>;
}

// Generate dynamic metadata for OG/Twitter cards
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { eventId } = await params;
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  
  if (!event) {
    return {
      title: 'Event Not Found',
    };
  }
  
  const eventDate = new Date(event.startsAt);
  const formattedDate = eventDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  
  const ticketsList = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(ticketTypes.sortOrder);

  const lowestPrice = ticketsList.length > 0
    ? Math.min(...ticketsList.map(t => t.price))
    : null;
  
  const priceText = lowestPrice !== null
    ? lowestPrice === 0 
      ? 'Free' 
      : `From CA\$${(lowestPrice / 100).toFixed(2)}`
    : '';
  
  const description = event.description
    ? event.description.slice(0, 200) + (event.description.length > 200 ? '...' : '')
    : `Join us for ${event.title} on ${formattedDate}`;
  
  const baseUrl = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
  const url = `${baseUrl}/${event.id}`;
  
  // Use event image or generate a placeholder description
  const ogImage = event.imageUrl || `${baseUrl}/api/og?title=${encodeURIComponent(event.title)}&date=${encodeURIComponent(formattedDate)}&location=${encodeURIComponent(event.city || 'Virtual')}`;
  
  return {
    title: `${event.title} | Imajin Events`,
    description,
    openGraph: {
      title: event.title,
      description,
      url,
      siteName: 'Imajin Events',
      type: 'website',
      images: event.imageUrl ? [{ url: event.imageUrl, width: 1200, height: 630 }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: event.title,
      description,
      images: event.imageUrl ? [event.imageUrl] : undefined,
    },
    other: {
      'event:date': eventDate.toISOString(),
      'event:location': event.city || 'Virtual',
      ...(priceText && { 'event:price': priceText }),
    },
  };
}

interface EventMetadata {
  featured?: boolean;
  theme?: {
    color?: string;
    emoji?: string;
    gradient?: [string, string];
  };
  virtualPlatform?: string;
  physicalThreshold?: number;
  [key: string]: unknown;
}

const colorGradients: Record<string, [string, string]> = {
  orange: ['from-orange-500', 'to-amber-600'],
  blue: ['from-blue-500', 'to-indigo-600'],
  green: ['from-green-500', 'to-emerald-600'],
  purple: ['from-purple-500', 'to-pink-600'],
  red: ['from-red-500', 'to-rose-600'],
};

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

async function getUserTickets(eventId: string, userDid: string) {
  const userTickets = await db
    .select({
      ticket: tickets,
      ticketType: ticketTypes,
    })
    .from(tickets)
    .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(
      and(
        eq(tickets.eventId, eventId),
        eq(tickets.ownerDid, userDid)
      )
    );

  return Promise.all(userTickets.map(async ({ ticket, ticketType }) => {
    // Generate QR code from ticket ID (for check-in scanning)
    const qrCodeDataUri = await generateQRCode(ticket.id) || undefined;

    return {
      id: ticket.id,
      status: ticket.status,
      purchasedAt: (ticket.purchasedAt || ticket.createdAt)?.toISOString() || null,
      pricePaid: ticket.pricePaid,
      currency: ticket.currency,
      qrCodeDataUri,
      ticketType: ticketType ? {
        name: ticketType.name,
        description: ticketType.description,
        perks: ticketType.perks,
      } : null,
    };
  }));
}

interface OrganizerProfile {
  did: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
  role: 'owner' | 'cohost';
}

async function resolveOrganizerProfile(did: string, authUrl: string): Promise<OrganizerProfile> {
  try {
    const res = await fetch(`${authUrl}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        did,
        name: identity.name || null,
        handle: identity.handle || null,
        avatar: identity.avatar || identity.avatarUrl || null,
        role: 'owner',
      };
    }
  } catch {}
  return { did, name: null, handle: null, avatar: null, role: 'owner' };
}

async function getCohosts(podId: string, authUrl: string): Promise<OrganizerProfile[]> {
  try {
    const rows = await sql`
      SELECT did FROM connections.pod_members
      WHERE pod_id = ${podId} AND role = 'cohost'
      ORDER BY joined_at ASC
    `;
    return Promise.all(
      rows.map(async (row) => {
        const profile = await resolveOrganizerProfile(row.did as string, authUrl);
        return { ...profile, role: 'cohost' as const };
      })
    );
  } catch {
    return [];
  }
}

export default async function EventPage({ params, searchParams }: Props) {
  const { eventId } = await params;
  const { invite: inviteToken } = await searchParams;
  const event = await getEvent(eventId);

  if (!event) {
    notFound();
  }

  const session = await getSession();
  const isCreator = session?.id === event.creatorDid;

  // Check if user is a cohost
  let isCohost = false;
  if (session?.id && event.podId && !isCreator) {
    try {
      const [member] = await sql`
        SELECT did FROM connections.pod_members
        WHERE pod_id = ${event.podId} AND did = ${session.id} AND role = 'cohost' AND removed_at IS NULL
        LIMIT 1
      `;
      isCohost = !!member;
    } catch {}
  }
  const isOrganizer = isCreator || isCohost;

  // Status-based visibility
  const status = event.status || 'draft';
  if (status === 'paused' && !isOrganizer) {
    notFound();
  }

  const ticketTypesList = await getTicketTypes(event.id);
  const canPurchaseTickets = status === 'published';

  // Invite-only access check
  let inviteValid = false;
  if (event.accessMode === 'invite_only' && inviteToken) {
    const [invite] = await db
      .select()
      .from(eventInvites)
      .where(and(eq(eventInvites.eventId, event.id), eq(eventInvites.token, inviteToken)))
      .limit(1);

    if (
      invite &&
      (!invite.expiresAt || new Date(invite.expiresAt) > new Date()) &&
      (invite.maxUses === null || invite.usedCount < invite.maxUses)
    ) {
      inviteValid = true;
    }
  }

  // Whether we should show the ticket purchase section
  const canSeeTickets =
    event.accessMode !== 'invite_only' || inviteValid || isOrganizer;

  // Fetch user's tickets if logged in
  const userTickets = session?.id ? await getUserTickets(event.id, session.id) : [];
  const hasTicket = userTickets.length > 0;

  // Resolve organizer profile and cohosts
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  const ownerProfile = await resolveOrganizerProfile(event.creatorDid, authUrl);
  const cohosts = event.podId ? await getCohosts(event.podId, authUrl) : [];
  const organizers: OrganizerProfile[] = [ownerProfile, ...cohosts];

  // Check if organizer has an email for e-transfer payments
  const [creatorProfileRow] = await sql`SELECT email FROM profile.profiles WHERE did = ${event.creatorDid}`;
  const etransferEnabled = !!creatorProfileRow?.email;

  const metadata = (event.metadata || {}) as EventMetadata;
  const theme = metadata.theme || {};
  const themeColor = theme.color || 'orange';
  const themeEmoji = theme.emoji || '🎉';
  const gradient = theme.gradient || colorGradients[themeColor] || colorGradients.orange;

  const eventDate = new Date(event.startsAt);
  const eventEndDate = event.endsAt ? new Date(event.endsAt) : null;
  const now = new Date();
  const isUpcoming = eventDate > now;
  const isOngoing = eventDate <= now && (!eventEndDate || eventEndDate > now);
  const isCompleted = eventEndDate ? eventEndDate < now : false;

  // Fetch surveys for this event
  const DYKIL_URL = process.env.NEXT_PUBLIC_DYKIL_URL || 'https://dykil.imajin.ai';
  let eventSurveys: any[] = [];
  try {
    const surveysRes = await fetch(`${DYKIL_URL}/api/surveys/event/${event.id}`, {
      cache: 'no-store',
    });
    if (surveysRes.ok) {
      const surveysData = await surveysRes.json();
      eventSurveys = surveysData.surveys || [];
    }
  } catch (err) {
    console.error('Failed to fetch event surveys:', err);
  }

  // Get survey visibility settings from event metadata
  const linkedSurveySettings: Record<string, { visibility: string; paywall: boolean; requiredForTickets: boolean }> = {};
  const linkedSurveysMeta = (event.metadata as any)?.linkedSurveys || [];
  for (const ls of linkedSurveysMeta) {
    linkedSurveySettings[ls.id] = { visibility: ls.visibility || 'always', paywall: ls.paywall || false, requiredForTickets: ls.requiredForTickets || false };
  }

  // Check if any surveys are required before ticket purchase
  const requiredSurveyIds = eventSurveys
    .filter((s: any) => s.requiredForTickets || linkedSurveySettings[s.id]?.requiredForTickets)
    .map((s: any) => s.id);

  let surveysCompleted = requiredSurveyIds.length === 0; // No required surveys = completed
  if (!surveysCompleted && session) {
    try {
      const checks = await Promise.all(
        requiredSurveyIds.map(async (surveyId: string) => {
          const checkRes = await fetch(`${DYKIL_URL}/api/surveys/${surveyId}/responses/check?did=${encodeURIComponent(session.id)}`, {
            cache: 'no-store',
          });
          if (checkRes.ok) {
            const data = await checkRes.json();
            return data.completed;
          }
          return false;
        })
      );
      surveysCompleted = checks.every(Boolean);
    } catch (err) {
      console.error('Failed to check survey completion:', err);
    }
  }

  // Filter surveys based on visibility settings and event state
  const visibleSurveys = eventSurveys.filter((survey: any) => {
    const settings = linkedSurveySettings[survey.id];
    if (!settings) return true; // No settings = show always
    
    if (settings.visibility === 'pre-event' && !isUpcoming && !isOngoing) return false;
    if (settings.visibility === 'post-event' && !isOngoing && !isCompleted) return false;
    // paywall filtering would happen client-side based on ticket ownership
    return true;
  });
  // Use event timezone if available, otherwise fall back to UTC
  const eventTz = (event as any).timezone || 'UTC';
  const formattedDate = eventDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: eventTz,
  });
  const formattedTime = eventDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: eventTz,
  });
  const formattedEndTime = eventEndDate ? eventEndDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: eventTz,
  }) : null;
  // If end date is a different day, show the full date too
  const endIsNewDay = eventEndDate && eventEndDate.toLocaleDateString('en-US', { timeZone: eventTz }) !== eventDate.toLocaleDateString('en-US', { timeZone: eventTz });
  const formattedEndDate = endIsNewDay ? eventEndDate!.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: eventTz,
  }) : null;
  
  // Calculate lowest price for sticky bar
  const lowestPrice = ticketTypesList.length > 0 ? Math.min(...ticketTypesList.map(t => t.price)) : null;
  const lowestPriceText = lowestPrice !== null
    ? lowestPrice === 0 ? 'Free' : `From CA\$${(lowestPrice / 100).toFixed(2)}`
    : '';

  return (
    <>
      <div className="max-w-5xl mx-auto pb-20 md:pb-8">
        {/* Hero Section - Mobile-first with full-bleed image */}
        <div className="relative -mx-4 md:mx-0 md:rounded-2xl overflow-hidden mb-6 md:mb-8">
          {event.imageUrl ? (
            <img
              src={event.imageUrl}
              alt={event.title}
              className="w-full h-[300px] md:h-[400px] object-cover"
            />
          ) : (
            <div className={`w-full h-[300px] md:h-[400px] bg-gradient-to-br ${gradient[0]} ${gradient[1]} flex items-center justify-center`}>
              <span className="text-7xl md:text-9xl">{themeEmoji}</span>
            </div>
          )}

          {/* Featured badge */}
          {metadata.featured && (
            <div className="absolute top-4 right-4 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm px-3 py-1.5 rounded-full text-xs md:text-sm font-semibold shadow-lg">
              ⭐ Featured
            </div>
          )}
        </div>

        {/* Status Banners */}
        {status === 'paused' && isOrganizer && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-yellow-900/30 border border-yellow-700 text-yellow-400 font-medium">
            This event is paused. It is not visible to the public.
          </div>
        )}
        {status === 'cancelled' && (
          <div className="mb-6 px-4 py-4 rounded-xl bg-red-900/30 border border-red-700 text-red-400 font-semibold text-center text-lg">
            This event has been cancelled.
          </div>
        )}
        {status === 'completed' && (
          <div className="mb-6 px-4 py-4 rounded-xl bg-blue-900/30 border border-blue-700 text-blue-400 font-semibold text-center text-lg">
            This event has ended.
          </div>
        )}

        {/* Event Info Card */}
        <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg p-6 md:p-8 mb-6">
          {/* Title and Share */}
          <div className="flex justify-between items-start gap-4 mb-6">
            <h1 className="text-3xl md:text-5xl font-bold leading-tight flex-1">{event.title}</h1>
            <div className="flex items-center gap-2">
              {isOrganizer && (
                <>
                  <Link
                    href={`/admin/${event.id}`}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-orange-500 dark:text-orange-400 hover:text-orange-600 dark:hover:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-900/20 rounded-lg transition font-medium"
                    title="Admin dashboard"
                  >
                    📊 Dashboard
                  </Link>
                  <Link
                    href={`/${event.id}/edit`}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-orange-500 dark:hover:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                    title="Edit event"
                  >
                    ✏️ Edit
                  </Link>
                </>
              )}
              <ShareButton />
            </div>
          </div>

          {/* Date/Time/Location Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="flex items-start gap-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <div className="text-2xl">📅</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-0.5">Date & Time</div>
                <div className="font-semibold">{formattedDate}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {formattedTime}
                  {formattedEndTime && (
                    <> — {formattedEndDate && <>{formattedEndDate}, </>}{formattedEndTime}</>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <div className="text-2xl">{event.isVirtual ? '💻' : '📍'}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-0.5">Location</div>
                <div className="font-semibold truncate">
                  {event.isVirtual ? 'Virtual Event' : event.venue || 'TBA'}
                </div>
                {!event.isVirtual && event.city && (
                  <div className="text-sm text-gray-600 dark:text-gray-400 truncate">{event.city}</div>
                )}
              </div>
            </div>
          </div>

          {/* Countdown */}
          {isUpcoming && (
            <div className="mb-6">
              <Countdown targetDate={event.startsAt.toISOString()} />
            </div>
          )}

          {/* Description */}
          {event.description && (
            <div className="mb-6">
              <MarkdownContent content={event.description} />
            </div>
          )}

          {/* Organizers */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              {organizers.length > 1 ? 'Organizers' : 'Organized by'}
            </div>
            <div className="flex flex-wrap gap-3">
              {organizers.map(org => (
                <div key={org.did} className="flex items-center gap-2">
                  {org.avatar ? (
                    <img
                      src={org.avatar}
                      alt={org.name || org.handle || org.did}
                      className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 text-sm font-semibold text-gray-500">
                      {(org.name || org.handle || org.did).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    {org.name && <p className="text-sm font-medium leading-none">{org.name}</p>}
                    {org.handle && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-none mt-0.5">@{org.handle}</p>
                    )}
                    {!org.name && !org.handle && (
                      <p className="text-xs text-gray-500 font-mono">{org.did.slice(0, 20)}...</p>
                    )}
                  </div>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                    org.role === 'owner'
                      ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300'
                      : 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                  }`}>
                    {org.role === 'owner' ? 'Organizer' : 'Co-host'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Pre-reading banner */}
        {event.courseSlug && (
          <div className="mb-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-5 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-blue-900 dark:text-blue-200">📚 Pre-reading available</p>
              <p className="text-sm text-blue-700 dark:text-blue-400 mt-1">
                Study the course material before the event to get the most out of it.
              </p>
            </div>
            <a
              href={`${process.env.NEXT_PUBLIC_LEARN_URL || 'https://learn.imajin.ai'}/course/${event.courseSlug}`}
              className="shrink-0 px-5 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium text-sm no-underline"
            >
              View Course →
            </a>
          </div>
        )}

        {/* Event Lobby Accordion */}
        <div className="mb-6">
          <EventLobbyAccordion eventId={event.id} />
        </div>

        {/* Event Surveys */}
        {visibleSurveys.map((survey: any) => {
          const settings = linkedSurveySettings[survey.id];
          return (
            <div key={survey.id} className="mb-6">
              <EventSurveyAccordion
                eventId={event.id}
                surveyId={survey.id}
                surveyTitle={survey.title}
                surveyType={survey.type}
                requiresTicket={(settings?.paywall || false) && !hasTicket}
              />
            </div>
          );
        })}

        {/* .fair Attribution */}
        <div className="mb-6">
          <FairAccordion manifest={(event.metadata as any)?.fair || null} />
        </div>

        {/* Tickets Section */}
        <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg p-6 md:p-8" id="tickets">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Tickets</h2>

          {!canSeeTickets ? (
            <div className="text-center py-12">
              <div className="text-5xl mb-4">🔒</div>
              <p className="text-lg font-semibold mb-2">This event is invite-only</p>
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                You need a valid invite link to purchase tickets.
              </p>
            </div>
          ) : canPurchaseTickets ? (
            <TicketsGate
              surveysRequired={requiredSurveyIds.length > 0}
              initialCompleted={surveysCompleted}
              requiredSurveyIds={requiredSurveyIds}
            >
              <TicketsSection
                eventId={event.id}
                eventTitle={event.title}
                tickets={ticketTypesList}
                userTickets={userTickets}
                hasTicket={hasTicket}
                inviteToken={inviteToken}
                etransferEnabled={etransferEnabled}
              />
            </TicketsGate>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              {status === 'cancelled' ? 'Ticket sales are closed — this event was cancelled.' :
               status === 'completed' ? 'This event has ended. Ticket sales are closed.' :
               'Ticket sales are not currently available.'}
            </p>
          )}
        </div>
      </div>

      {/* Mobile Sticky Bottom Bar — only for purchasable events */}
      {canPurchaseTickets && canSeeTickets && surveysCompleted && ticketTypesList.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 md:hidden bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-4 py-3 shadow-lg z-50">
          <a
            href="#tickets"
            className="block w-full text-center px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition-colors"
          >
            Get Tickets
          </a>
        </div>
      )}
    </>
  );
}
