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
import { getSession } from '@/src/lib/auth';
import { getClient } from '@imajin/db';

const sql = getClient();

interface Props {
  params: Promise<{ eventId: string }>;
}

export default async function AdminPage({ params }: Props) {
  const { eventId } = await params;

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
  
  return (
    <div className="max-w-6xl mx-auto p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{event.title}</h1>
        <p className="text-gray-600 dark:text-gray-400">Admin Dashboard</p>
      </div>

      {/* Status Controls */}
      <EventStatusControls eventId={event.id} currentStatus={event.status || 'draft'} />

      {/* Co-host Management */}
      <div className="mb-8">
        <CohostManager eventId={event.id} isOwner={isOwner} />
      </div>

      {/* Invite Link Management */}
      <InviteManager eventId={event.id} accessMode={event.accessMode || 'public'} />

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


function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
