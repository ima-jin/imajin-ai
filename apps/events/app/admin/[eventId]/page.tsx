/**
 * Admin view for event ticket management
 * /admin/[eventId]
 */

import { db, events, tickets, ticketTypes } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { EventStatusControls } from './event-status-controls';
import { CohostManager } from './cohost-manager';
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
      
      {/* Attendee List */}
      <div>
        <h2 className="text-xl font-semibold mb-4">
          Attendees ({allTickets.length})
        </h2>
        
        {allTickets.length === 0 ? (
          <p className="text-gray-500">No tickets sold yet.</p>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold">Email</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold">Ticket</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold">Paid</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold">Date</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {allTickets.map(({ ticket, tierName }) => {
                  const email = (ticket.metadata as any)?.purchaseEmail || 
                    ticket.ownerDid?.replace('did:email:', '').replace('_at_', '@') || 
                    'Unknown';
                  
                  return (
                    <tr key={ticket.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                      <td className="px-4 py-3 text-sm">{email}</td>
                      <td className="px-4 py-3 text-sm">{tierName}</td>
                      <td className="px-4 py-3 text-sm">
                        {formatCurrency(ticket.pricePaid || 0, ticket.currency || 'CAD')}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {ticket.createdAt 
                          ? new Date(ticket.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <StatusBadge status={ticket.status} usedAt={ticket.usedAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
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

function StatusBadge({ status, usedAt }: { status: string; usedAt: Date | null }) {
  if (usedAt) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
        ✓ Checked In
      </span>
    );
  }
  
  switch (status) {
    case 'valid':
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          Valid
        </span>
      );
    case 'held':
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          Held
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
          Cancelled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
          {status}
        </span>
      );
  }
}

function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
