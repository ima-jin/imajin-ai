'use client';

import { useState } from 'react';
import type { TicketType } from '@/src/db/schema';
import { apiFetch } from '@imajin/config';
import { TicketPurchase } from './ticket-purchase';
import { OnboardGate } from '@imajin/onboard';
import { SurveyAccordion } from './survey-accordion';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface FairSettlementFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
  amount: number;
  estimated?: boolean;
}

interface FairSettlement {
  version?: string;
  settledAt: string;
  totalAmount: number;
  netAmount?: number;   // post-fee organizer total (WO2/3)
  currency: string;
  fees?: FairSettlementFee[];
  chain: { did: string; amount: number; role: string }[];
}

interface OrderTicket {
  id: string;
  status: string;
  usedAt: string | null;
  registrationStatus: string;
  pricePaid: number | null;
  currency: string | null;
  qrCodeDataUri?: string;
  ticketType: {
    name: string;
    description: string | null;
    perks: unknown;
    registrationFormId?: string | null;
  } | null;
}

interface UserOrder {
  id: string;
  isLegacy: boolean;
  quantity: number;
  totalAmount: number | null;
  currency: string | null;
  purchasedAt: string | null;
  ticketTypeName: string;
  fairSettlement: FairSettlement | null;
  tickets: OrderTicket[];
}

interface Props {
  eventId: string;
  eventTitle: string;
  tickets: TicketType[];
  userOrders?: UserOrder[];
  hasTicket?: boolean;
  inviteToken?: string;
  etransferEnabled?: boolean;
  isAuthenticated?: boolean;
  sessionEmail?: string;
  sellerConnected?: boolean;
}

export function TicketsSection({ eventId, eventTitle, tickets, userOrders = [], hasTicket = false, inviteToken, etransferEnabled = false, isAuthenticated = false, sessionEmail, sellerConnected = true }: Props) {
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
  if (!hasTicket || userOrders.length === 0) {
    return <PurchaseUI eventId={eventId} eventTitle={eventTitle} tickets={tickets} inviteToken={inviteToken} etransferEnabled={etransferEnabled} isAuthenticated={isAuthenticated} sessionEmail={sessionEmail} sellerConnected={sellerConnected} />;
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
          {tickets.every(t => t.price === 0) ? '🎫 Get More Tickets' : '🛒 Buy More Tickets'}
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'my-tickets' ? (
        <MyTicketsTab userOrders={userOrders} eventId={eventId} />
      ) : (
        <PurchaseUI eventId={eventId} eventTitle={eventTitle} tickets={tickets} inviteToken={inviteToken} etransferEnabled={etransferEnabled} isAuthenticated={isAuthenticated} sessionEmail={sessionEmail} sellerConnected={sellerConnected} />
      )}
    </div>
  );
}

function MyTicketsTab({ userOrders, eventId }: { userOrders: UserOrder[]; eventId: string }) {
  return (
    <div className="space-y-6">
      {userOrders.map((order) => (
        <OrderCard key={order.id} order={order} eventId={eventId} />
      ))}
    </div>
  );
}

function OrderCard({ order, eventId }: { order: UserOrder; eventId: string }) {
  const purchaseDate = order.purchasedAt
    ? new Date(order.purchasedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'N/A';

  const formattedTotal = order.totalAmount !== null && order.currency
    ? order.totalAmount === 0
      ? 'Free'
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: order.currency,
        }).format(order.totalAmount / 100)
    : 'N/A';

  const headerLabel = order.quantity > 1
    ? `${order.quantity}× ${order.ticketTypeName}`
    : order.ticketTypeName;

  return (
    <div className="border-2 border-orange-500 dark:border-orange-500 rounded-xl p-6 bg-orange-50/50 dark:bg-orange-900/10">
      {/* Order header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h3 className="text-xl font-bold">{headerLabel}</h3>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">📅 {purchaseDate}</div>
        </div>
        <div className="text-2xl font-bold text-orange-500 shrink-0">{formattedTotal}</div>
      </div>

      {/* QR grid */}
      <div className={`grid gap-4 mb-5 ${order.tickets.length === 1 ? 'grid-cols-1 max-w-[200px]' : 'grid-cols-2 sm:grid-cols-3'}`}>
        {order.tickets.map((ticket) => (
          <TicketQRCell key={ticket.id} ticket={ticket} eventId={eventId} />
        ))}
      </div>

      {/* Registration surveys — full width, outside the QR grid */}
      {order.tickets.filter(t => t.ticketType?.registrationFormId).map((ticket) => (
        <div key={`reg-${ticket.id}`} className="mb-4">
          <TicketRegistrationSurvey ticket={ticket} eventId={eventId} />
        </div>
      ))}

      {/* ONE .fair receipt per order */}
      {order.fairSettlement && (
        <TicketFairReceipt settlement={order.fairSettlement} />
      )}
    </div>
  );
}

function TicketQRCell({ ticket }: { ticket: OrderTicket; eventId: string }) {
  const isPending = ticket.registrationStatus === 'pending';
  const [qrCode] = useState(ticket.qrCodeDataUri);

  return (
    <div className="flex flex-col items-center gap-2">
      {isPending ? (
        <div className="text-center">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400">
            ⏳ Registration Required
          </span>
        </div>
      ) : (
        <>
          <div className="bg-gray-900 dark:bg-[#0a0a0a] border border-gray-700 dark:border-gray-800 rounded-lg p-2 text-center">
            {qrCode && (
              <img
                src={qrCode}
                alt="Ticket QR Code"
                width={120}
                height={120}
                className="mx-auto mb-1"
              />
            )}
            <div className="font-mono text-[9px] text-gray-400 truncate max-w-[120px]">
              {ticket.id}
            </div>
          </div>
          <div className="text-xs font-medium capitalize text-gray-600 dark:text-gray-400 text-center">
            🎟️ {ticket.status === 'used'
              ? `Checked In${ticket.usedAt ? ` · ${timeAgo(ticket.usedAt)}` : ''}`
              : ticket.status}
          </div>
        </>
      )}

    </div>
  );
}

function TicketRegistrationSurvey({ ticket, eventId }: { ticket: OrderTicket; eventId: string }) {
  const [regStatus, setRegStatus] = useState(ticket.registrationStatus);
  const isPending = regStatus === 'pending';

  async function handleRegistrationComplete() {
    try {
      const res = await apiFetch(`/api/register/${ticket.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: ticket.ticketType?.registrationFormId }),
      });
      if (res.ok) {
        setRegStatus('complete');
      }
    } catch {
      // Non-fatal — survey is saved in Dykil
    }
  }

  if (!ticket.ticketType?.registrationFormId) return null;

  return (
    <SurveyAccordion
      eventId={eventId}
      surveyId={ticket.ticketType.registrationFormId}
      surveyTitle={isPending ? 'Complete Registration' : 'Registration'}
      surveyType="form"
      defaultExpanded={isPending}
      ticketId={ticket.id}
      onComplete={handleRegistrationComplete}
    />
  );
}

const ROLE_LABELS: Record<string, string> = {
  buyer_credit: 'Your credit',
  node: 'Node',
  platform: 'Protocol (MJN)',
  seller: 'Organizer',
  creator: 'Creator',
};

function TicketFairReceipt({ settlement }: { settlement: FairSettlement }) {
  const [open, setOpen] = useState(false);
  const currencyFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: settlement.currency || 'CAD',
  });

  // netAmount: explicit field (WO2/3) or derived from seller chain entry
  const netAmount = settlement.netAmount
    ?? settlement.chain.find(e => e.role === 'seller')?.amount
    ?? null;

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-gray-800 pt-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
      >
        <span>⚖️</span>
        <span>.fair settlement receipt</span>
        {netAmount !== null && (
          <span className="text-xs text-orange-500 font-medium">
            Organizer receives {currencyFmt.format(netAmount)}
          </span>
        )}
        <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {settlement.chain.map((entry, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-900/60 rounded-lg text-sm"
            >
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${
                  entry.role === 'seller' ? 'bg-orange-500' :
                  entry.role === 'buyer_credit' ? 'bg-green-500' :
                  entry.role === 'platform' ? 'bg-blue-500' :
                  'bg-gray-500'
                }`} />
                <span className="font-medium">{ROLE_LABELS[entry.role] ?? entry.role}</span>
                <span className="text-xs text-gray-400 truncate max-w-[120px]" title={entry.did}>
                  {entry.did.length > 24 ? entry.did.slice(0, 10) + '…' + entry.did.slice(-6) : entry.did}
                </span>
              </div>
              <span className="font-bold">{currencyFmt.format(entry.amount)}</span>
            </div>
          ))}
          {settlement.fees && settlement.fees.length > 0 && settlement.fees.map((fee, i) => (
            <div
              key={`fee-${i}`}
              className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-900/60 rounded-lg text-sm"
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-gray-400" />
                <span className="font-medium text-gray-500">{fee.name}</span>
                <span className="text-xs text-gray-400">
                  {(fee.rateBps / 100).toFixed(1)}%{fee.fixedCents > 0 ? ` + ${currencyFmt.format(fee.fixedCents / 100)}` : ''}
                </span>
              </div>
              <span className="font-bold text-gray-500">
                {fee.estimated ? '~' : ''}{currencyFmt.format(fee.amount)}
              </span>
            </div>
          ))}
          <div className="flex justify-between px-3 pt-2 border-t border-gray-200 dark:border-gray-800 text-sm">
            <span className="text-gray-500">Total paid</span>
            <span className="font-bold">{currencyFmt.format(settlement.totalAmount)}</span>
          </div>
          {netAmount !== null && (
            <div className="flex justify-between px-3 py-1 text-sm">
              <span className="text-gray-500">Organizer receives</span>
              <span className="font-bold text-orange-500">{currencyFmt.format(netAmount)}</span>
            </div>
          )}
          <p className="text-[10px] text-gray-400 px-3">
            Settled {new Date(settlement.settledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {' · '}
            <a href="https://github.com/ima-jin/.fair" target="_blank" rel="noopener noreferrer" className="hover:text-orange-500 transition">.fair</a>
            {' '}v{settlement.version || '1.0'}
          </p>
        </div>
      )}
    </div>
  );
}

function PurchaseUI({ eventId, eventTitle, tickets, inviteToken, etransferEnabled = false, isAuthenticated = false, sessionEmail, sellerConnected = true }: { eventId: string; eventTitle: string; tickets: TicketType[]; inviteToken?: string; etransferEnabled?: boolean; isAuthenticated?: boolean; sessionEmail?: string; sellerConnected?: boolean }) {
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

              <div className="flex flex-col items-stretch md:items-end gap-3">
                <div className="text-left md:text-right">
                  <div className="text-3xl md:text-4xl font-bold">
                    {ticket.price === 0 ? 'Free' : `CA$${(ticket.price / 100).toFixed(2)}`}
                  </div>
                  {ticket.price > 0 && (
                    <div className="text-sm text-gray-500">{ticket.currency}</div>
                  )}
                </div>

                {ticket.price > 0 && !sellerConnected ? (
                  etransferEnabled ? (
                    <TicketPurchase
                      eventId={eventId}
                      eventTitle={eventTitle}
                      ticket={ticket}
                      inviteToken={inviteToken}
                      etransferEnabled={etransferEnabled}
                      stripeDisabled={true}
                      sessionEmail={sessionEmail}
                    />
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      Payments not yet available
                    </p>
                  )
                ) : isAuthenticated || !etransferEnabled ? (
                  <TicketPurchase
                    eventId={eventId}
                    eventTitle={eventTitle}
                    ticket={ticket}
                    inviteToken={inviteToken}
                    etransferEnabled={etransferEnabled}
                    sessionEmail={sessionEmail}
                  />
                ) : (
                  <OnboardGate
                    action="purchase a ticket"
                    onIdentity={() => window.location.reload()}
                    requireVerification={true}
                    authUrl={process.env.NEXT_PUBLIC_AUTH_URL}
                  >
                    <TicketPurchase
                      eventId={eventId}
                      eventTitle={eventTitle}
                      ticket={ticket}
                      inviteToken={inviteToken}
                      etransferEnabled={etransferEnabled}
                      sessionEmail={sessionEmail}
                    />
                  </OnboardGate>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
