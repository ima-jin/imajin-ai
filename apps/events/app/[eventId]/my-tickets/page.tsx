import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/src/lib/auth';
import { db, tickets, ticketTypes, ticketRegistrations, events } from '@/src/db';
import { eq, and, or } from 'drizzle-orm';
import { CopyLinkButton } from './copy-link-button';

interface Props {
  params: Promise<{ eventId: string }>;
}

export const dynamic = 'force-dynamic';

function RegistrationBadge({ status }: { status: string }) {
  if (status === 'complete') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">
        ✅ Registered
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400">
        ⏳ Pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
      —
    </span>
  );
}

export default async function MyTicketsPage({ params }: Props) {
  const { eventId } = await params;

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

  const eventsUrl = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

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
          {userTicketRows.map(({ ticket, ticketType }) => {
            const registration = registrationMap.get(ticket.id);
            const isPending = ticket.registrationStatus === 'pending';
            const regPath = `/${eventId}/register/${ticket.id}${ticket.magicToken ? `?token=${ticket.magicToken}` : ''}`;
            const copyUrl = `${eventsUrl}/${eventId}/register/${ticket.id}${ticket.magicToken ? `?token=${ticket.magicToken}` : ''}`;

            return (
              <div
                key={ticket.id}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <h2 className="font-semibold text-lg">{ticketType?.name || 'Ticket'}</h2>
                    {ticket.pricePaid != null && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {new Intl.NumberFormat('en-CA', {
                          style: 'currency',
                          currency: ticket.currency || 'CAD',
                        }).format(ticket.pricePaid / 100)}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 font-mono mt-0.5">{ticket.id}</p>
                  </div>
                  <RegistrationBadge status={ticket.registrationStatus} />
                </div>

                {ticket.registrationStatus === 'complete' && registration && (
                  <div className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-sm mt-2">
                    <p className="font-medium">{registration.name}</p>
                    <p className="text-gray-500 dark:text-gray-400">{registration.email}</p>
                  </div>
                )}

                {isPending && (
                  <div className="mt-4 flex flex-col sm:flex-row gap-3">
                    <Link
                      href={regPath}
                      className="flex-1 text-center px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition"
                    >
                      Register
                    </Link>
                    <CopyLinkButton url={copyUrl} />
                  </div>
                )}
              </div>
            );
          })}
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
