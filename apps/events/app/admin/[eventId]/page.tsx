/**
 * Admin view for event ticket management
 * /admin/[eventId]
 */

import { db, events, tickets, ticketTypes } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { EventStatusControls } from './event-status-controls';
import { CohostManager } from './cohost-manager';
import { GuestList } from './guest-list';
import { InviteManager } from './invite-manager';
import { MessageComposer } from './message-composer';
import { getSession } from '@imajin/auth';
import { getClient } from '@imajin/db';

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
  const isOwner = session?.id === event.creatorDid;

  if (!isOwner && event.podId) {
    // Check if viewer is a cohost
    const podRows = await sql`
      SELECT role FROM connections.pod_members
      WHERE pod_id = ${event.podId} AND did = ${session?.id ?? ''} AND role IN ('owner', 'cohost')
      LIMIT 1
    `;
    if (!podRows.length) {
      notFound();
    }
  } else if (!isOwner) {
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
  
  // Calculate stats
  const totalSold = allTickets.length;
  const totalRevenue = allTickets.reduce((sum, t) => sum + (t.ticket.pricePaid || 0), 0);
  const checkedIn = allTickets.filter(t => t.ticket.usedAt).length;

  // Count distinct confirmed attendees for broadcast
  const confirmedAttendeeRows = await sql`
    SELECT COUNT(DISTINCT owner_did) AS count
    FROM events.tickets
    WHERE event_id = ${eventId}
      AND status IN ('valid', 'used')
      AND owner_did IS NOT NULL
  `;
  const confirmedAttendeeCount = Number(confirmedAttendeeRows[0]?.count ?? 0);
  
  return (
    <div className="max-w-6xl mx-auto p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{event.title}</h1>
        <p className="text-gray-600 dark:text-gray-400">Admin Dashboard</p>
      </div>

      {/* Status Controls */}
      <EventStatusControls eventId={event.id} currentStatus={event.status || 'draft'} />

      {/* Name Display Policy */}
      <div className="mb-8 flex items-center gap-3">
        <span className="text-sm text-gray-500 dark:text-gray-400">Attendee name display:</span>
        <NamePolicyBadge policy={(event as any).nameDisplayPolicy || 'attendee_choice'} />
        <a
          href={`/${event.id}/edit`}
          className="text-xs text-orange-500 hover:text-orange-600 underline"
        >
          Change
        </a>
      </div>

      {/* Co-host Management */}
      <div className="mb-8">
        <CohostManager eventId={event.id} isOwner={isOwner} />
      </div>

      {/* Invite Link Management */}
      <InviteManager eventId={event.id} accessMode={event.accessMode || 'public'} />

      {/* Message Attendees */}
      <MessageComposer eventId={event.id} recipientCount={confirmedAttendeeCount} />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Tickets Sold" value={totalSold} />
        <StatCard label="Revenue" value={formatCurrency(totalRevenue, 'CAD')} />
        <StatCard label="Checked In" value={`${checkedIn} / ${totalSold}`} />
        <StatCard 
          label="Event Date" 
          value={new Date(event.startsAt).toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric' 
          })} 
        />
      </div>
      
      {/* Ticket Tiers */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Ticket Tiers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tiers.map(tier => (
            <div 
              key={tier.id} 
              className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow"
            >
              <h3 className="font-semibold">{tier.name}</h3>
              <p className="text-2xl font-bold mt-2">
                {tier.sold} <span className="text-sm text-gray-500">/ {tier.quantity ?? '∞'}</span>
              </p>
              <p className="text-sm text-gray-500">
                {formatCurrency(tier.price, tier.currency)} each
              </p>
            </div>
          ))}
        </div>
      </div>
      
      {/* Guest List */}
      <GuestList eventId={eventId} isOwner={isOwner} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}


const NAME_POLICY_LABELS: Record<string, { label: string; color: string }> = {
  attendee_choice: { label: 'Attendee choice', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  real_name:       { label: 'Real name',       color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  handle:          { label: 'Handle only',     color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  anonymous:       { label: 'Anonymous',       color: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
};

function NamePolicyBadge({ policy }: { policy: string }) {
  const meta = NAME_POLICY_LABELS[policy] ?? NAME_POLICY_LABELS['attendee_choice'];
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
