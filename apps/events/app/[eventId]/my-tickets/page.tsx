import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/src/lib/auth';
import { db, tickets, ticketTypes, ticketRegistrations, events } from '@/src/db';
import { eq, and, or } from 'drizzle-orm';
import { generateQRCode } from '@/src/lib/email';
import { MyTicketCard } from './my-ticket-card';

interface Props {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ ticket?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function MyTicketsPage({ params, searchParams }: Props) {
  const { eventId } = await params;
  const { ticket: ticketParam } = await searchParams;

  const session = await getSession();
  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
    const eventsUrl = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
    redirect(`${authUrl}/login?next=${encodeURIComponent(`${eventsUrl}/${eventId}/my-tickets`)}`);
  }

  const [event] = await db
    .select({ id: events.id, title: events.title })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    notFound();
  }

  // Get all tickets owned by or originally purchased by this user for this event
  const userTicketRows = await db
    .select({ ticket: tickets, ticketType: ticketTypes })
    .from(tickets)
    .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(
      and(
        eq(tickets.eventId, eventId),
        or(
          eq(tickets.ownerDid, session.id),
          eq(tickets.originalOwnerDid, session.id)
        )
      )
    );

  // Fetch registrations for completed tickets
  const completedTicketIds = userTicketRows
    .filter(r => r.ticket.registrationStatus === 'complete')
    .map(r => r.ticket.id);

  const registrationMap = new Map<string, { name: string; email: string }>();
  if (completedTicketIds.length > 0) {
    const regResults = await Promise.all(
      completedTicketIds.map(id =>
        db
          .select({ name: ticketRegistrations.name, email: ticketRegistrations.email })
          .from(ticketRegistrations)
          .where(eq(ticketRegistrations.ticketId, id))
          .limit(1)
      )
    );
    regResults.forEach((rows, i) => {
      if (rows.length > 0) {
        registrationMap.set(completedTicketIds[i], { name: rows[0].name, email: rows[0].email });
      }
    });
  }

  // Generate QR codes for non-pending tickets
  const qrMap = new Map<string, string | undefined>();
  await Promise.all(
    userTicketRows.map(async ({ ticket }) => {
      if (ticket.registrationStatus !== 'pending') {
        const qr = await generateQRCode(ticket.id);
        qrMap.set(ticket.id, qr || undefined);
      }
    })
  );

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="mb-8">
        <p className="text-sm text-orange-500 font-medium mb-1">{event.title}</p>
        <h1 className="text-3xl font-bold">My Tickets</h1>
      </div>

      {userTicketRows.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 text-center">
          <div className="text-4xl mb-4">🎫</div>
          <h2 className="text-xl font-semibold mb-2">No tickets found</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            You don&apos;t have any tickets for this event yet.
          </p>
          <Link
            href={`/${eventId}`}
            className="inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
          >
            Get Tickets →
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {userTicketRows.map(({ ticket, ticketType }) => (
            <MyTicketCard
              key={ticket.id}
              ticketId={ticket.id}
              eventId={eventId}
              ticketTypeName={ticketType?.name || 'Ticket'}
              pricePaid={ticket.pricePaid}
              currency={ticket.currency}
              purchasedAt={(ticket.purchasedAt || ticket.createdAt)?.toISOString() || null}
              registrationStatus={ticket.registrationStatus || 'not_required'}
              registrationFormId={ticketType?.registrationFormId || null}
              registration={registrationMap.get(ticket.id) || null}
              qrCodeDataUri={qrMap.get(ticket.id)}
              autoExpand={ticketParam === ticket.id}
            />
          ))}
        </div>
      )}

      <div className="mt-6 text-center">
        <Link
          href={`/${eventId}`}
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        >
          ← Back to Event
        </Link>
      </div>
    </div>
  );
}
