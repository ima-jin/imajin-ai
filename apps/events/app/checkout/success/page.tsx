import Link from 'next/link';
import { db, ticketTypes, events, orders } from '@/src/db';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { AutoRedirect } from './auto-redirect';
import { buildPublicUrl, eventCheckoutSuccessPath } from '@imajin/config';

interface Props {
  searchParams: Promise<{ session_id?: string; event?: string }>;
}

interface EventSummary {
  id: string;
  title: string;
  startsAt: Date | null;
  imageUrl: string | null;
}

export const dynamic = 'force-dynamic';

async function loadEventSummary(
  eventId: string | undefined,
): Promise<{ event: EventSummary | null; hasRegistrationRequired: boolean }> {
  if (!eventId) return { event: null, hasRegistrationRequired: false };

  const [found] = await db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt, imageUrl: events.imageUrl })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  const event = found || null;
  if (!event) return { event: null, hasRegistrationRequired: false };

  const tiers = await db
    .select({ requiresRegistration: ticketTypes.requiresRegistration })
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));

  return { event, hasRegistrationRequired: tiers.some((t) => t.requiresRegistration) };
}

async function findOnboardToken(email: string): Promise<string | null> {
  const authSql = getClient();
  const rows = await authSql<{ token: string }[]>`
    SELECT token FROM auth.onboard_tokens
    WHERE email = ${email.toLowerCase().trim()}
      AND used_at IS NULL
      AND expires_at > NOW()
      AND created_at > NOW() - INTERVAL '10 minutes'
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows.length > 0 ? rows[0].token : null;
}

function extractBuyerEmail(order: { buyerEmail: string | null; metadata: unknown }): string | null {
  const meta = (order.metadata || {}) as Record<string, unknown>;
  return order.buyerEmail || (meta.purchaseEmail as string | undefined) || null;
}

// Try to auto-authenticate via onboard token created by the webhook
async function resolveMagicLink(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;

  const [order] = await db
    .select({ buyerEmail: orders.buyerEmail, metadata: orders.metadata })
    .from(orders)
    .where(eq(orders.stripeSessionId, sessionId))
    .limit(1);
  if (!order) return null;

  const email = extractBuyerEmail(order);
  if (!email) return null;

  const token = await findOnboardToken(email);
  if (!token) return null;

  return `${buildPublicUrl('auth')}/api/onboard/verify?token=${token}`;
}

function EventHeroBanner({ event }: Readonly<{ event: EventSummary | null }>) {
  return (
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
  );
}

function WhatsWaitingCard() {
  return (
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
  );
}

function RegistrationRequiredNotice({ show, href }: Readonly<{ show: boolean; href: string }>) {
  if (!show) return null;

  return (
    <div className="bg-red-50 dark:bg-red-900/20 border-2 border-red-400 dark:border-red-600 rounded-2xl p-6 mb-8 text-center animate-pulse">
      <div className="text-3xl mb-3">⚠️</div>
      <h3 className="text-xl font-bold text-red-600 dark:text-red-400 mb-2">
        Registration Required!
      </h3>
      <p className="text-red-600 dark:text-red-400 font-medium mb-4">
        You must complete the registration form before your tickets are confirmed.
      </p>
      <Link
        href={href}
        className="inline-block px-6 py-3 bg-red-500 hover:bg-red-600 text-white text-sm font-bold rounded-lg transition"
      >
        Complete Registration Now →
      </Link>
      <AutoRedirect href={href} seconds={10} />
    </div>
  );
}

function EventCtaButtons({ event, href }: Readonly<{ event: EventSummary | null; href: string }>) {
  const label = event ? 'Go to the Event →' : 'Browse Events';
  const target = event ? href : '/';

  return (
    <div className="flex flex-col sm:flex-row gap-4 justify-center">
      <Link
        href={target}
        className="inline-block px-8 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-semibold text-lg"
      >
        {label}
      </Link>
    </div>
  );
}

export default async function SuccessPage({ searchParams }: Readonly<Props>) {
  const params = await searchParams;

  const { event, hasRegistrationRequired } = await loadEventSummary(params.event);
  const magicLink = await resolveMagicLink(params.session_id);

  const eventCtaHref = magicLink || (event ? eventCheckoutSuccessPath(event.id) : '/');

  return (
    <div className="max-w-2xl mx-auto text-center py-8 px-4">
      <EventHeroBanner event={event} />
      <WhatsWaitingCard />
      <RegistrationRequiredNotice show={hasRegistrationRequired && Boolean(event)} href={eventCtaHref} />
      <EventCtaButtons event={event} href={eventCtaHref} />

      {params.session_id && (
        <p className="text-sm text-gray-500 mt-8">
          Order: {params.session_id.slice(0, 20)}...
        </p>
      )}
    </div>
  );
}
