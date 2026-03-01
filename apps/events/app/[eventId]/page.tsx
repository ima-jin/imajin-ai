import { notFound } from 'next/navigation';
import { db, events, ticketTypes } from '@/src/db';
import { eq } from 'drizzle-orm';
import { TicketPurchase } from './ticket-purchase';
import { Countdown } from './countdown';
import { EventChatButton } from './event-chat-button';
import { ShareButton } from './share-button';
import type { Metadata } from 'next';

interface Props {
  params: Promise<{ eventId: string }>;
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
  
  const tickets = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));
  
  const lowestPrice = tickets.length > 0
    ? Math.min(...tickets.map(t => t.price))
    : null;
  
  const priceText = lowestPrice !== null
    ? lowestPrice === 0 
      ? 'Free' 
      : `From $${(lowestPrice / 100).toFixed(0)}`
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
    .where(eq(ticketTypes.eventId, eventId));
}

export default async function EventPage({ params }: Props) {
  const { eventId } = await params;
  const event = await getEvent(eventId);
  
  if (!event) {
    notFound();
  }
  
  const tickets = await getTicketTypes(event.id);
  const metadata = (event.metadata || {}) as EventMetadata;
  const theme = metadata.theme || {};
  const themeColor = theme.color || 'orange';
  const themeEmoji = theme.emoji || '🎉';
  const gradient = theme.gradient || colorGradients[themeColor] || colorGradients.orange;
  
  const eventDate = new Date(event.startsAt);
  const isUpcoming = eventDate > new Date();
  const formattedDate = eventDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const formattedTime = eventDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  
  // Calculate lowest price for sticky bar
  const lowestPrice = tickets.length > 0 ? Math.min(...tickets.map(t => t.price)) : null;
  const lowestPriceText = lowestPrice !== null
    ? lowestPrice === 0 ? 'Free' : `From $${(lowestPrice / 100).toFixed(0)}`
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

        {/* Event Info Card */}
        <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg p-6 md:p-8 mb-6">
          {/* Title and Share */}
          <div className="flex justify-between items-start gap-4 mb-6">
            <h1 className="text-3xl md:text-5xl font-bold leading-tight flex-1">{event.title}</h1>
            <ShareButton />
          </div>

          {/* Date/Time/Location Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="flex items-start gap-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <div className="text-2xl">📅</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-0.5">Date & Time</div>
                <div className="font-semibold">{formattedDate}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{formattedTime}</div>
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
            <div className="prose dark:prose-invert max-w-none mb-6">
              <p className="text-base md:text-lg whitespace-pre-wrap leading-relaxed">
                {event.description}
              </p>
            </div>
          )}

          {/* Organizer */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Organized by</div>
            <div className="font-medium">{event.creatorDid.slice(0, 30)}...</div>
          </div>
        </div>

        {/* Event Chat Button */}
        <div className="mb-6">
          <EventChatButton eventId={event.id} />
        </div>

        {/* Tickets Section */}
        <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg p-6 md:p-8" id="tickets">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Tickets</h2>

          {tickets.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-5xl mb-4">🎫</div>
              <p className="text-gray-500 dark:text-gray-400 text-lg">No tickets available yet</p>
            </div>
          ) : (
            <div className="space-y-3 md:space-y-4">
              {tickets.map((ticket) => {
                const available = ticket.quantity === null
                  ? null
                  : ticket.quantity - (ticket.sold ?? 0);
                const soldOut = ticket.quantity !== null && (ticket.sold ?? 0) >= ticket.quantity;
                const lowStock = available !== null && available > 0 && available <= 10;

                return (
                  <div
                    key={ticket.id}
                    className="group border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 md:p-6 hover:border-orange-500 dark:hover:border-orange-500 transition-all"
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-start gap-3 mb-2">
                          <h3 className="font-bold text-xl flex-1">{ticket.name}</h3>
                          {soldOut && (
                            <span className="px-3 py-1 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-xs font-semibold rounded-full">
                              SOLD OUT
                            </span>
                          )}
                          {lowStock && !soldOut && (
                            <span className="px-3 py-1 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 text-xs font-semibold rounded-full">
                              {available} LEFT
                            </span>
                          )}
                        </div>

                        {ticket.description && (
                          <p className="text-gray-600 dark:text-gray-400 mb-3">
                            {ticket.description}
                          </p>
                        )}

                        {Array.isArray(ticket.perks) && ticket.perks.length > 0 && (
                          <ul className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                            {ticket.perks.map((perk, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="text-orange-500 mt-0.5">✓</span>
                                <span>{String(perk)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="flex md:flex-col items-center md:items-end gap-4 md:gap-3">
                        <div className="flex-1 md:flex-none text-left md:text-right">
                          <div className="text-3xl md:text-4xl font-bold">
                            {ticket.price === 0 ? 'Free' : `$${(ticket.price / 100).toFixed(0)}`}
                          </div>
                          {ticket.price > 0 && (
                            <div className="text-sm text-gray-500">{ticket.currency}</div>
                          )}
                        </div>

                        <TicketPurchase
                          eventId={event.id}
                          eventTitle={event.title}
                          ticket={ticket}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Mobile Sticky Bottom Bar */}
      {tickets.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 md:hidden bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-4 py-3 shadow-lg z-50">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Starting at</div>
              <div className="text-2xl font-bold">{lowestPriceText}</div>
            </div>
            <a
              href="#tickets"
              className="px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition-colors"
            >
              Get Tickets
            </a>
          </div>
        </div>
      )}
    </>
  );
}
