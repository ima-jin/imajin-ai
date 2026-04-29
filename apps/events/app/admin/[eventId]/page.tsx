/**
 * Admin view for event ticket management
 * /admin/[eventId]
 */

import { db, events, tickets, ticketTypes } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { GuestList } from './guest-list';
import { getSession } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { AdminTabs } from './admin-tabs';

const sql = getClient();

interface Props {
  params: { eventId: string };
}

export default async function AdminPage({ params }: Props) {
  const { eventId } = params as unknown as { eventId: string };

  // Fetch event
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    notFound();
  }

  // Auth check: viewer must be owner or cohost
  const session = await getSession();
  const actingDid = session ? (session.actingAs || session.id) : null;
  const isCreator = session?.id === event.creatorDid || session?.actingAs === event.creatorDid;

  // Auth gate: creator, acting-as creator, or cohost
  let isOrganizer = isCreator;
  if (!isCreator && event.podId && actingDid) {
    const podRows = await sql`
      SELECT role FROM connections.pod_members
      WHERE pod_id = ${event.podId} AND did = ${actingDid} AND role IN ('owner', 'cohost')
      LIMIT 1
    `;
    if (podRows.length) {
      isOrganizer = true;
    } else {
      notFound();
    }
  } else if (!isCreator) {
    notFound();
  }

  // Fetch ticket types with stats
  const tiers = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));

  // Fetch all tickets
  const allTickets = await db
    .select({
      ticket: tickets,
      tierName: ticketTypes.name,
    })
    .from(tickets)
    .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(eq(tickets.eventId, eventId))
    .orderBy(desc(tickets.createdAt));

  // Calculate stats — exclude cancelled/refunded from "sold" count
  const activeTickets = allTickets.filter(t => !['cancelled', 'refunded'].includes(t.ticket.status));
  const totalSold = activeTickets.length;
  const confirmedRevenue = allTickets
    .filter(t => t.ticket.status === 'valid' || t.ticket.status === 'used')
    .reduce((sum, t) => sum + (t.ticket.pricePaid || 0), 0);
  const heldRevenue = allTickets
    .filter(t => t.ticket.status === 'held')
    .reduce((sum, t) => sum + (t.ticket.pricePaid || 0), 0);
  const checkedIn = allTickets.filter(t => t.ticket.usedAt).length;

  // Count cohosts
  let cohostCount = 0;
  if (event.podId) {
    const cohostRows = await sql`
      SELECT COUNT(*) as count FROM connections.pod_members
      WHERE pod_id = ${event.podId} AND role = 'cohost' AND removed_at IS NULL
    `;
    cohostCount = Number(cohostRows[0]?.count ?? 0);
  }

  // Count invites
  const inviteRows = await sql`
    SELECT COUNT(*) as count FROM events.event_invites
    WHERE event_id = ${eventId}
  `;
  const inviteCount = Number(inviteRows[0]?.count ?? 0);

  // Count distinct confirmed attendees for broadcast
  const confirmedAttendeeRows = await sql`
    SELECT COUNT(DISTINCT owner_did) AS count
    FROM events.tickets
    WHERE event_id = ${eventId}
      AND status IN ('valid', 'used')
      AND owner_did IS NOT NULL
  `;
  const confirmedAttendeeCount = Number(confirmedAttendeeRows[0]?.count ?? 0);

  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8">
      {/* Header */}
      <div className="mb-4 md:mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{event.title}</h1>
          <p className="text-gray-600 dark:text-gray-400">Admin Dashboard</p>
        </div>
        <a
          href={`${basePath}/${eventId}`}
          className="text-sm text-orange-500 hover:text-orange-600 font-medium flex items-center gap-1"
        >
          ← View Live Event
        </a>
      </div>

      {/* Tabs + Tab Content */}
      <AdminTabs
        eventId={eventId}
        eventTitle={event.title}
        eventStatus={event.status || 'draft'}
        isOwner={isOrganizer}
        ownerDid={event.creatorDid}
        accessMode={event.accessMode || 'public'}
        cohostCount={cohostCount}
        inviteCount={inviteCount}
        confirmedAttendeeCount={confirmedAttendeeCount}
        totalSold={totalSold}
        confirmedRevenue={confirmedRevenue}
        heldRevenue={heldRevenue}
        checkedIn={checkedIn}
        tiers={tiers}
        eventDate={event.startsAt.toISOString()}
        basePath={basePath}
      />

      {/* Guest List — always visible below tabs, lazy loaded */}
      <div className="mt-8">
        <GuestList
          eventId={eventId}
          isOwner={isOrganizer}
          summary={{
            totalTickets: totalSold,
            confirmedRevenue,
            checkedIn,
          }}
        />
      </div>
    </div>
  );
}
