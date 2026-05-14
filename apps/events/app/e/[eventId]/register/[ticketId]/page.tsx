import { notFound } from 'next/navigation';
import Link from 'next/link';
import { db, tickets, ticketTypes, events } from '@/src/db';
import { eq } from 'drizzle-orm';
import RegisterForm from './register-form';

interface Props {
  params: Promise<{ eventId: string; ticketId: string }>;
  searchParams: Promise<{ token?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function RegisterPage({ params, searchParams }: Props) {
  const { eventId, ticketId } = await params;
  const { token } = await searchParams;

  // Load ticket with its type
  const [row] = await db
    .select({ ticket: tickets, ticketType: ticketTypes })
    .from(tickets)
    .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!row?.ticket || !row?.ticketType) {
    notFound();
  }

  const { ticket, ticketType } = row;

  // Verify event matches the URL
  if (ticket.eventId !== eventId) {
    notFound();
  }

  // Magic token validation removed — auth handled via onboard session + DID match

  // Check registration status
  if (ticket.registrationStatus === 'complete') {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-2xl font-bold mb-2">Already Registered</h1>
        <p className="text-gray-600 dark:text-gray-400">
          This ticket has already been registered.
        </p>
        <Link
          href={`/${eventId}`}
          className="mt-6 inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
        >
          Go to Event →
        </Link>
      </div>
    );
  }

  if (ticket.registrationStatus !== 'pending') {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <div className="text-5xl mb-4">🎫</div>
        <h1 className="text-2xl font-bold mb-2">Registration Not Required</h1>
        <p className="text-gray-600 dark:text-gray-400">
          This ticket does not require registration.
        </p>
        <Link
          href={`/${eventId}`}
          className="mt-6 inline-block text-orange-500 hover:text-orange-600 font-medium"
        >
          ← Back to Event
        </Link>
      </div>
    );
  }

  // Load event title
  const [event] = await db
    .select({ id: events.id, title: events.title })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    notFound();
  }

  const formId = ticketType.registrationFormId || 'none';
  const hasCustomForm = !!ticketType.registrationFormId;

  return (
    <div className="max-w-lg mx-auto py-8 px-4">
      <div className="mb-8">
        <p className="text-sm text-orange-500 font-medium mb-1">{event.title}</p>
        <h1 className="text-3xl font-bold">Register Your Ticket</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">{ticketType.name}</p>
      </div>

      <RegisterForm
        ticketId={ticketId}
        eventId={eventId}
        eventTitle={event.title}
        ticketTypeName={ticketType.name}
        hasCustomForm={hasCustomForm}
        formId={formId}
      />

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
