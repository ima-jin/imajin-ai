'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { TicketType } from '@/src/db/schema';
import { apiFetch } from '@imajin/config';
import { TicketPurchase } from './ticket-purchase';
import { SurveyAccordion } from './survey-accordion';
import { useToast } from '@imajin/ui';

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';

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
  sessionContactEmail?: string;
  sellerConnected?: boolean;
  hasHiddenTiers?: boolean;
}

export function TicketsSection({ eventId, eventTitle, tickets, userOrders = [], hasTicket = false, inviteToken, etransferEnabled = false, isAuthenticated = false, sessionEmail, sessionContactEmail, sellerConnected = true, hasHiddenTiers = false }: Props) {
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
    return <PurchaseUI eventId={eventId} eventTitle={eventTitle} tickets={tickets} inviteToken={inviteToken} etransferEnabled={etransferEnabled} isAuthenticated={isAuthenticated} sessionEmail={sessionEmail} sellerConnected={sellerConnected} hasHiddenTiers={hasHiddenTiers} />;
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
        <PurchaseUI eventId={eventId} eventTitle={eventTitle} tickets={tickets} inviteToken={inviteToken} etransferEnabled={etransferEnabled} isAuthenticated={isAuthenticated} sessionEmail={sessionEmail} sessionContactEmail={sessionContactEmail} sellerConnected={sellerConnected} hasHiddenTiers={hasHiddenTiers} />
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
      {/* Defensive: also exclude tickets explicitly marked not_required so a
          DB misconfig (registrationFormId set on a type that shouldn't need it)
          doesn't force a form on the buyer. */}
      {order.tickets.filter(t => t.ticketType?.registrationFormId && t.registrationStatus !== 'not_required').map((ticket) => (
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
  const [isRetrying, setIsRetrying] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const isPending = regStatus === 'pending';
  const router = useRouter();
  const { toast } = useToast();

  async function handleRegistrationComplete() {
    setIsRetrying(true);
    setLastError(null);
    try {
      const res = await apiFetch(`/api/register/${ticket.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: ticket.ticketType?.registrationFormId }),
      });
      if (res.ok) {
        setRegStatus('complete');
        toast.success('Registration completed successfully');
        // Refresh server data so QR code appears
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        const msg = data.error || `Registration failed (${res.status})`;
        setLastError(msg);
        toast.error(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      setLastError(msg);
      toast.error(msg);
    } finally {
      setIsRetrying(false);
    }
  }

  if (!ticket.ticketType?.registrationFormId) return null;

  return (
    <div>
      <SurveyAccordion
        eventId={eventId}
        surveyId={ticket.ticketType.registrationFormId}
        surveyTitle={isPending ? 'Complete Registration' : 'Registration'}
        surveyType="form"
        defaultExpanded={isPending}
        ticketId={ticket.id}
        initialCompleted={!isPending}
        onComplete={handleRegistrationComplete}
      />
      {lastError && (
        <div className="mt-2 flex items-center gap-3">
          <span className="text-sm text-red-500">{lastError}</span>
          <button
            onClick={handleRegistrationComplete}
            disabled={isRetrying}
            className="px-3 py-1 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 transition"
          >
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}
    </div>
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

function PurchaseUI({ eventId, eventTitle, tickets, inviteToken, etransferEnabled = false, isAuthenticated = false, sessionEmail, sessionContactEmail, sellerConnected = true, hasHiddenTiers = false }: { eventId: string; eventTitle: string; tickets: TicketType[]; inviteToken?: string; etransferEnabled?: boolean; isAuthenticated?: boolean; sessionEmail?: string; sessionContactEmail?: string; sellerConnected?: boolean; hasHiddenTiers?: boolean }) {
  const [unlockedTickets, setUnlockedTickets] = useState<TicketType[]>([]);
  const [unlockCode, setUnlockCode] = useState('');
  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const { toast } = useToast();

  // Lifted quantity state for unified cart
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const allTickets = [...tickets, ...unlockedTickets];

  // Compute cart totals
  const paidTickets = allTickets.filter(t => t.price > 0);
  const hasPaidTickets = paidTickets.length > 0;
  const cartItems = paidTickets
    .filter(t => (quantities[t.id] || 0) > 0)
    .map(t => ({ ticket: t, qty: quantities[t.id] || 0 }));
  const totalQty = cartItems.reduce((sum, item) => sum + item.qty, 0);
  const totalCents = cartItems.reduce((sum, item) => sum + item.ticket.price * item.qty, 0);
  // Detect mixed currency in cart — e-Transfer + card both require a single
  // currency per checkout. Surface this client-side so the user sees a useful
  // message instead of a server-side toast after they've gone through verify.
  const cartCurrencies = Array.from(new Set(cartItems.map((c) => c.ticket.currency)));
  const mixedCurrency = cartCurrencies.length > 1;
  const cartCurrency = cartCurrencies[0] || paidTickets[0]?.currency || 'CAD';
  const formattedTotal = new Intl.NumberFormat('en-CA', { style: 'currency', currency: cartCurrency }).format(totalCents / 100);

  async function handleUnlock() {
    if (!unlockCode.trim()) return;
    setUnlockLoading(true);
    setUnlockError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/tiers/unlock?code=${encodeURIComponent(unlockCode.trim())}`);
      const data = await res.json();
      if (!res.ok) {
        setUnlockError(data.error || 'Invalid code');
        return;
      }
      const newTiers = (data.tiers || []).filter((t: TicketType) => !allTickets.some(existing => existing.id === t.id));
      if (newTiers.length === 0) {
        setUnlockError('No new ticket types found for this code');
        return;
      }
      setUnlockedTickets(prev => [...prev, ...newTiers]);
      setShowUnlock(false);
      setUnlockCode('');
      toast.success(`${newTiers.length} ticket type${newTiers.length > 1 ? 's' : ''} unlocked!`);
    } catch {
      setUnlockError('Failed to unlock. Please try again.');
    } finally {
      setUnlockLoading(false);
    }
  }

  return (
    <div className="space-y-3 md:space-y-4">
      {allTickets.map((ticket) => {
        const available = ticket.quantity === null
          ? null
          : ticket.quantity - (ticket.sold ?? 0);
        const soldOut = ticket.quantity !== null && (ticket.sold ?? 0) >= ticket.quantity;
        const lowStock = available !== null && available > 0 && available <= 10;
        const isUnlocked = unlockedTickets.some(t => t.id === ticket.id);

        return (
          <div
            key={ticket.id}
            className={`group border-2 rounded-xl p-4 md:p-6 hover:border-orange-500 dark:hover:border-orange-500 transition-all ${
              isUnlocked
                ? 'border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-start gap-3 mb-2">
                  <h3 className="font-bold text-xl flex-1">{ticket.name}</h3>
                  {isUnlocked && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-semibold rounded-full">
                      🔓 Unlocked
                    </span>
                  )}
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
                      quantity={quantities[ticket.id] || 0}
                      onQuantityChange={(q) => setQuantities(prev => ({ ...prev, [ticket.id]: q }))}
                      hideCheckoutButton={true}
                    />
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      Payments not yet available
                    </p>
                  )
                ) : (
                  // Per-ticket UI: just the quantity stepper for paid tickets
                  // (checkout happens via the unified cart bar below), or the
                  // RSVP button for free tickets. Email collection is handled
                  // inline by TicketPurchase itself when needed — never gate
                  // the stepper, which has no side-effects.
                  <TicketPurchase
                    eventId={eventId}
                    eventTitle={eventTitle}
                    ticket={ticket}
                    inviteToken={inviteToken}
                    etransferEnabled={etransferEnabled}
                    sessionEmail={sessionEmail}
                    quantity={ticket.price > 0 ? (quantities[ticket.id] || 0) : undefined}
                    onQuantityChange={ticket.price > 0 ? (q) => setQuantities(prev => ({ ...prev, [ticket.id]: q })) : undefined}
                    hideCheckoutButton={ticket.price > 0}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Unified checkout bar */}
      {hasPaidTickets && (
        <UnifiedCheckoutBar
          eventId={eventId}
          inviteToken={inviteToken}
          cartItems={cartItems}
          totalQty={totalQty}
          formattedTotal={formattedTotal}
          etransferEnabled={etransferEnabled}
          sessionEmail={sessionEmail}
          sessionContactEmail={sessionContactEmail}
          onError={(msg) => toast.error(msg)}
          mixedCurrency={mixedCurrency}
          cartCurrencies={cartCurrencies}
        />
      )}

      {/* Unlock hidden tiers */}
      {hasHiddenTiers && (
        <div className="pt-4">
          {!showUnlock ? (
            <button
              onClick={() => setShowUnlock(true)}
              className="text-sm text-orange-500 hover:text-orange-600 font-medium flex items-center gap-1"
            >
              🔑 Have an access code?
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <input
                  type="text"
                  value={unlockCode}
                  onChange={(e) => setUnlockCode(e.target.value)}
                  placeholder="Enter access code..."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                />
                {unlockError && (
                  <p className="text-xs text-red-500 mt-1">{unlockError}</p>
                )}
              </div>
              <button
                onClick={handleUnlock}
                disabled={unlockLoading || !unlockCode.trim()}
                className="px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
              >
                {unlockLoading ? '…' : 'Unlock'}
              </button>
              <button
                onClick={() => { setShowUnlock(false); setUnlockError(null); }}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface UnifiedBarProps {
  eventId: string;
  inviteToken?: string;
  cartItems: { ticket: TicketType; qty: number }[];
  totalQty: number;
  formattedTotal: string;
  etransferEnabled: boolean;
  sessionEmail?: string;
  sessionContactEmail?: string;
  onError: (msg: string) => void;
  mixedCurrency?: boolean;
  cartCurrencies?: string[];
}

function UnifiedCheckoutBar({ eventId, inviteToken, cartItems, totalQty, formattedTotal, etransferEnabled, sessionEmail, sessionContactEmail, onError, mixedCurrency = false, cartCurrencies = [] }: UnifiedBarProps) {
  const router = useRouter();
  type BarStep = 'idle' | 'card-loading' | 'emt-form' | 'emt-loading' | 'emt-done' | 'emt-verify-sent';
  const [step, setStep] = useState<BarStep>('idle');
  const [emtEmail, setEmtEmail] = useState(sessionContactEmail || sessionEmail || '');
  const [emtName, setEmtName] = useState('');
  const [emtResult, setEmtResult] = useState<{ orderId: string; quantity: number; email: string; amount: number; currency: string; memo: string; deadline: string; message: string } | null>(null);
  const [verifySentTo, setVerifySentTo] = useState<string | null>(null);
  // Issue #1: polling state for tab-A-canonical verification
  const [pollHandle, setPollHandle] = useState<string | null>(null);
  const [pollStatus, setPollStatus] = useState<'pending' | 'completed' | 'claimed' | 'expired' | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [showFallbackHint, setShowFallbackHint] = useState(false);

  const first = cartItems[0];
  const multiType = cartItems.length > 1;

  async function startStripe() {
    if (!first) return;
    // Issue #4: require email if no contactEmail on file
    if (!sessionContactEmail && !emtEmail.includes('@')) {
      onError('Please enter your email address');
      return;
    }
    setStep('card-loading');
    try {
      const res = await apiFetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          ticketTypeId: first.ticket.id,
          quantity: first.qty,
          ...(inviteToken && { invite: inviteToken }),
          ...(!sessionContactEmail && emtEmail && { email: emtEmail.trim() }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || 'Checkout failed');
        setStep('idle');
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      onError('Checkout failed');
      setStep('idle');
    }
  }

  async function startEtransfer() {
    if (!first) return;
    // Issue #4: use sessionContactEmail to decide if we need the form
    if (!sessionContactEmail && !emtEmail.includes('@')) {
      setStep('emt-form');
      return;
    }
    setStep('emt-loading');
    try {
      const res = await apiFetch('/api/checkout/etransfer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          // Send the full cart — server creates one order spanning all types.
          items: cartItems.map((c) => ({ ticketTypeId: c.ticket.id, quantity: c.qty })),
          ...(inviteToken && { invite: inviteToken }),
          // Issue #4: always pass email when available (even if session exists)
          ...(emtEmail && { email: emtEmail.trim() }),
          ...(emtName && { name: emtName.trim() }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || 'e-Transfer setup failed');
        setStep('idle');
        return;
      }
      const data = await res.json();
      // Magic-link verification path: server didn't create a hold yet.
      if (data.verificationSent) {
        setVerifySentTo(data.email || emtEmail || sessionEmail || null);
        setPollHandle(data.pollHandle || null);
        setPollStatus('pending');
        setPollError(null);
        setShowFallbackHint(false);
        setStep('emt-verify-sent');
        return;
      }
      setEmtResult({
        orderId: data.orderId,
        quantity: data.instructions.quantity ?? totalQty,
        email: data.instructions.email,
        amount: data.instructions.amount,
        currency: data.instructions.currency,
        memo: data.instructions.memo,
        deadline: data.instructions.deadline,
        message: data.instructions.message,
      });
      setStep('emt-done');
      router.refresh();
    } catch {
      onError('e-Transfer setup failed');
      setStep('idle');
    }
  }

  // Issue #1: polling loop for tab-A-canonical verification
  useEffect(() => {
    if (step !== 'emt-verify-sent' || !pollHandle) return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${AUTH_URL}/api/onboard/poll?handle=${encodeURIComponent(pollHandle)}`);
        if (!res.ok) return;
        const data = await res.json();
        setPollStatus(data.status);

        if (data.status === 'completed' && data.handoffToken) {
          clearInterval(pollInterval);
          // Claim the session in tab A context
          const claimRes = await fetch(`${AUTH_URL}/api/onboard/claim`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handoffToken: data.handoffToken }),
          });
          if (!claimRes.ok) {
            const errData = await claimRes.json().catch(() => ({}));
            setPollError(errData.error || 'Failed to complete verification');
            setPollStatus('expired');
            return;
          }
          // Notify any listening components (e.g. NavBar) that auth changed.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('imajin:session-changed'));
          }
          // Re-fire the EMT reserve directly without router.refresh().
          // Calling startEtransfer() triggers router.refresh() which re-runs
          // server components, flips hasTicket from false → true, and remounts
          // PurchaseUI — wiping cart state. We handle the transition client-side.
          setPollStatus(null);
          setPollHandle(null);
          setStep('emt-loading');
          try {
            const reserveRes = await apiFetch('/api/checkout/etransfer', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                eventId,
                items: cartItems.map((c) => ({ ticketTypeId: c.ticket.id, quantity: c.qty })),
                ...(inviteToken && { invite: inviteToken }),
                ...(emtEmail && { email: emtEmail.trim() }),
                ...(emtName && { name: emtName.trim() }),
              }),
            });
            if (!reserveRes.ok) {
              const errData = await reserveRes.json().catch(() => ({}));
              onError(errData.error || 'e-Transfer setup failed');
              setStep('idle');
              return;
            }
            const reserveData = await reserveRes.json();
            setEmtResult({
              orderId: reserveData.orderId,
              quantity: reserveData.instructions.quantity ?? totalQty,
              email: reserveData.instructions.email,
              amount: reserveData.instructions.amount,
              currency: reserveData.instructions.currency,
              memo: reserveData.instructions.memo,
              deadline: reserveData.instructions.deadline,
              message: reserveData.instructions.message,
            });
            setStep('emt-done');
          } catch {
            onError('e-Transfer setup failed');
            setStep('idle');
          }
        } else if (data.status === 'expired' || data.status === 'claimed') {
          clearInterval(pollInterval);
          setPollError('Verification link expired. Please try again.');
        }
      } catch {
        // Polling errors are non-fatal — keep trying
      }
    }, 2000);

    // Fallback hint after ~30s
    const fallbackTimeout = setTimeout(() => {
      setShowFallbackHint(true);
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(fallbackTimeout);
    };
  }, [step, pollHandle]);

  if (step === 'emt-verify-sent') {
    const isPolling = pollStatus === 'pending' || pollStatus === 'completed';
    const isExpired = pollStatus === 'expired' || pollStatus === 'claimed' || !!pollError;
    return (
      <div className="sticky bottom-0 -mx-4 px-4 py-4 bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur border-t border-gray-200 dark:border-gray-700 rounded-b-xl space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-orange-500 text-xl">📨</span>
          <h3 className="font-semibold text-base">
            {isExpired ? 'Verification expired' : isPolling ? 'Waiting for verification…' : 'Check your email to confirm'}
          </h3>
        </div>
        {isExpired ? (
          <>
            <p className="text-sm text-red-500">{pollError || 'Verification link expired — please try again.'}</p>
            <button
              onClick={() => {
                setStep('idle');
                setPollHandle(null);
                setPollStatus(null);
                setPollError(null);
                setShowFallbackHint(false);
              }}
              className="px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 transition"
            >
              Try Again
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              We sent a verification link to <strong className="text-gray-800 dark:text-gray-100">{verifySentTo}</strong>.
              Click it to confirm your email and we'll reserve your {totalQty} ticket{totalQty !== 1 ? 's' : ''} automatically.
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Link expires in 15 minutes. Check spam if you don't see it.
            </p>
            {showFallbackHint && (
              <p className="text-xs text-amber-500">
                Still waiting? Make sure you clicked the link in your email. If you already verified, you can{' '}
                <button
                  onClick={() => {
                    setStep('idle');
                    setPollHandle(null);
                    setPollStatus(null);
                    setPollError(null);
                    setShowFallbackHint(false);
                  }}
                  className="text-orange-500 hover:underline font-medium"
                >
                  retry
                </button>.
              </p>
            )}
            <button
              onClick={() => { setStep('emt-form'); setVerifySentTo(null); setPollHandle(null); setPollStatus(null); }}
              className="text-xs text-orange-500 hover:underline"
            >
              Use a different email
            </button>
          </>
        )}
      </div>
    );
  }

  if (step === 'emt-done' && emtResult) {
    return (
      <div className="sticky bottom-0 -mx-4 px-4 py-4 bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur border-t border-gray-200 dark:border-gray-700 rounded-b-xl space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-orange-500 text-xl">📬</span>
          <h3 className="font-semibold text-base">Reserved — send your e-Transfer to confirm</h3>
        </div>
        <p className="text-xs text-orange-500">
          You don't have your ticket{emtResult.quantity > 1 ? 's' : ''} yet. They'll be activated once we confirm your payment — we'll email you the ticket{emtResult.quantity > 1 ? 's' : ''} then.
        </p>
        <div className="text-sm space-y-1.5">
          <div className="flex justify-between"><span className="text-gray-500">Amount</span><span className="font-semibold">{new Intl.NumberFormat('en-CA', { style: 'currency', currency: emtResult.currency }).format(emtResult.amount)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Send your e-Transfer to</span><span className="font-mono">{emtResult.email}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Memo</span><span className="font-mono font-semibold text-orange-500">{emtResult.memo}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Pay by</span><span>{new Date(emtResult.deadline).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
        </div>
        <p className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 rounded-lg p-3">{emtResult.message}</p>
        {emtResult.quantity > 1 && (
          <p className="text-xs text-gray-500">Reserved {emtResult.quantity} tickets in one order. Send a single e-Transfer for the full amount.</p>
        )}
      </div>
    );
  }

  if (step === 'emt-form') {
    return (
      <div className="sticky bottom-0 -mx-4 px-4 py-4 bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur border-t border-gray-200 dark:border-gray-700 rounded-b-xl space-y-3">
        <h3 className="font-semibold text-base">🏦 Pay by e-Transfer</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Reserves {totalQty} ticket{totalQty !== 1 ? 's' : ''} for 72 hours while you send your e-Transfer.
        </p>
        {cartItems.length > 1 && (
          <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
            {cartItems.map((c) => (
              <li key={c.ticket.id}>{c.qty} × {c.ticket.name}</li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input type="text" placeholder="Your name" value={emtName} onChange={(e) => setEmtName(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm" />
          <div>
            <input
              type="email"
              placeholder={sessionContactEmail ? 'Your email' : 'Your email — where should we send your ticket?'}
              value={emtEmail}
              onChange={(e) => setEmtEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
            />
            {!sessionContactEmail && (
              <p className="text-xs text-gray-500 mt-1">Email required to send your ticket.</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={startEtransfer} disabled={!emtEmail.includes('@')} className={`px-5 py-2.5 rounded-lg font-semibold transition ${!emtEmail.includes('@') ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-orange-500 text-white hover:bg-orange-600'}`}>Reserve My Ticket</button>
          <button onClick={() => setStep('idle')} className="px-3 py-2.5 text-sm text-gray-500 hover:text-gray-700">Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sticky bottom-0 -mx-4 px-4 py-4 bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur border-t border-gray-200 dark:border-gray-700 rounded-b-xl">
      {/* Issue #4: email collection when no contactEmail on file */}
      {totalQty > 0 && !sessionContactEmail && (
        <div className="mb-3">
          <input
            type="email"
            placeholder="Your email — where should we send your ticket?"
            value={emtEmail}
            onChange={(e) => setEmtEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">Email required to send your ticket.</p>
        </div>
      )}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {totalQty === 0 ? (
            'Select tickets above'
          ) : (
            <span className="text-base font-semibold text-white">
              {totalQty} ticket{totalQty !== 1 ? 's' : ''} · {formattedTotal}
            </span>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={startStripe}
            disabled={totalQty === 0 || mixedCurrency || step === 'card-loading' || step === 'emt-loading' || (!sessionContactEmail && !emtEmail.includes('@'))}
            className={`px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap ${
              totalQty === 0 || mixedCurrency || step === 'card-loading' || (!sessionContactEmail && !emtEmail.includes('@'))
                ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-orange-500 text-white hover:bg-orange-600'
            }`}
          >
            {step === 'card-loading' ? 'Loading…' : totalQty === 0 ? '💳 Pay with Card' : `💳 Pay with Card — ${formattedTotal}`}
          </button>
          {etransferEnabled && (
            <button
              onClick={startEtransfer}
              disabled={totalQty === 0 || mixedCurrency || step === 'card-loading' || step === 'emt-loading' || (!sessionContactEmail && !emtEmail.includes('@'))}
              className={`px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap border ${
                totalQty === 0 || mixedCurrency || (!sessionContactEmail && !emtEmail.includes('@'))
                  ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                  : 'bg-orange-500/20 text-orange-500 border-orange-500/40 hover:bg-orange-500/30'
              }`}
            >
              {step === 'emt-loading' ? 'Reserving…' : '🏦 Pay by e-Transfer'}
            </button>
          )}
        </div>
      </div>
      {/* Mixed-currency block: takes priority over the multi-type hint */}
      {mixedCurrency && (
        <p className="text-xs text-red-500 mt-2">
          ⚠️ Your cart mixes currencies ({cartCurrencies.join(' + ')}). Pick tickets in one currency to check out together.
        </p>
      )}
      {/* Multi-type hint: only relevant when card is the only path. With
          e-Transfer enabled, EMT covers the whole cart in one go and the user
          doesn't need this warning. */}
      {!mixedCurrency && multiType && !etransferEnabled && (
        <p className="text-xs text-amber-500 mt-2">
          ⚠️ Card payment is single-type only — you'll check out {first?.ticket.name} first, then return for the rest.
        </p>
      )}
      {!mixedCurrency && etransferEnabled && totalQty > 0 && (
        <p className="text-xs text-gray-400 mt-1">
          e-Transfer pays the organizer directly. One transfer covers all reserved tickets.
        </p>
      )}
    </div>
  );
}
