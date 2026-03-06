'use client';

import { useState } from 'react';
import type { TicketType } from '@/src/db/schema';
import { TicketPurchase } from './ticket-purchase';

interface UserTicket {
  id: string;
  status: string;
  purchasedAt: string | null;
  pricePaid: number | null;
  currency: string | null;
  qrCodeDataUri?: string;
  ticketType: {
    name: string;
    description: string | null;
    perks: unknown;
  } | null;
}

interface Props {
  eventId: string;
  eventTitle: string;
  tickets: TicketType[];
  userTickets?: UserTicket[];
  hasTicket?: boolean;
  inviteToken?: string;
}

export function TicketsSection({ eventId, eventTitle, tickets, userTickets = [], hasTicket = false, inviteToken }: Props) {
  const [activeTab, setActiveTab] = useState<'my-tickets' | 'buy-tickets'>(
    hasTicket ? 'my-tickets' : 'buy-tickets'
  );

  // If no tickets available at all
  if (tickets.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-5xl mb-4">🎫</div>
        <p className="text-gray-500 dark:text-gray-400 text-lg">No tickets available yet</p>
      </div>
    );
  }

  // If user doesn't have tickets, show purchase UI only
  if (!hasTicket || userTickets.length === 0) {
    return <PurchaseUI eventId={eventId} eventTitle={eventTitle} tickets={tickets} inviteToken={inviteToken} />;
  }

  // User has tickets - show tabbed interface
  return (
    <div>
      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('my-tickets')}
          className={`px-4 py-2 font-semibold transition-colors border-b-2 ${
            activeTab === 'my-tickets'
              ? 'border-orange-500 text-orange-500'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          🎫 My Tickets
        </button>
        <button
          onClick={() => setActiveTab('buy-tickets')}
          className={`px-4 py-2 font-semibold transition-colors border-b-2 ${
            activeTab === 'buy-tickets'
              ? 'border-orange-500 text-orange-500'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          🛒 Buy More Tickets
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'my-tickets' ? (
        <MyTicketsTab userTickets={userTickets} />
      ) : (
        <PurchaseUI eventId={eventId} eventTitle={eventTitle} tickets={tickets} inviteToken={inviteToken} />
      )}
    </div>
  );
}

function MyTicketsTab({ userTickets }: { userTickets: UserTicket[] }) {
  return (
    <div className="space-y-4">
      {userTickets.map((ticket) => {
        const purchaseDate = ticket.purchasedAt
          ? new Date(ticket.purchasedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : 'N/A';

        const formattedPrice = ticket.pricePaid !== null && ticket.currency
          ? ticket.pricePaid === 0
            ? 'Free'
            : new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: ticket.currency,
              }).format(ticket.pricePaid / 100)
          : 'N/A';

        const perks = ticket.ticketType?.perks;
        const perksArray = Array.isArray(perks) ? perks : [];

        return (
          <div
            key={ticket.id}
            className="border-2 border-orange-500 dark:border-orange-500 rounded-xl p-6 bg-orange-50/50 dark:bg-orange-900/10"
          >
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-6 items-start">
              {/* Left: ticket info */}
              <div>
                <h3 className="text-2xl font-bold mb-1">
                  {ticket.ticketType?.name || 'Ticket'}
                </h3>
                {ticket.ticketType?.description && (
                  <p className="text-gray-600 dark:text-gray-400 mb-2">
                    {ticket.ticketType.description}
                  </p>
                )}
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                  <span>📅 {purchaseDate}</span>
                </div>
                {perksArray.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                    {perksArray.map((perk, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-orange-500 mt-0.5">✓</span>
                        <span>{String(perk)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Center: QR code + status */}
              <div className="flex flex-col items-center">
                <div className="bg-gray-900 dark:bg-[#0a0a0a] border border-gray-700 dark:border-gray-800 rounded-lg p-3 text-center">
                  {ticket.qrCodeDataUri && (
                    <img
                      src={ticket.qrCodeDataUri}
                      alt="Ticket QR Code"
                      width={140}
                      height={140}
                      className="mx-auto mb-2"
                    />
                  )}
                  <div className="font-mono text-[10px] text-gray-400">
                    {ticket.id}
                  </div>
                </div>
                <div className="mt-2 text-sm font-medium capitalize text-gray-600 dark:text-gray-400">
                  🎟️ {ticket.status}
                </div>
              </div>

              {/* Right: price */}
              <div className="text-right">
                <div className="text-3xl font-bold text-orange-500">
                  {formattedPrice}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PurchaseUI({ eventId, eventTitle, tickets, inviteToken }: { eventId: string; eventTitle: string; tickets: TicketType[]; inviteToken?: string }) {
  return (
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
                    {ticket.price === 0 ? 'Free' : `CA\${(ticket.price / 100).toFixed(2)}`}
                  </div>
                  {ticket.price > 0 && (
                    <div className="text-sm text-gray-500">{ticket.currency}</div>
                  )}
                </div>

                <TicketPurchase
                  eventId={eventId}
                  eventTitle={eventTitle}
                  ticket={ticket}
                  inviteToken={inviteToken}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
