'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useToast } from '@imajin/ui';
import { apiFetch } from '@imajin/config';
import { TicketScanner } from './ticket-scanner';

interface Profile {
  name: string | null;
  handle: string | null;
  avatar: string | null;
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
  netAmount?: number;
  currency: string;
  fees?: FairSettlementFee[];
  chain: Array<{ did: string; amount: number; role: string }>;
}

interface Guest {
  id: string;
  status: string;
  ownerDid: string | null;
  pricePaid: number | null;
  currency: string | null;
  purchasedAt: string | null;
  usedAt: string | null;
  ticketType: string;
  paymentMethod: string | null;
  paymentId: string | null;
  holdExpiresAt: string | null;
  profile: Profile | null;
  registrationStatus: string | null;
  attendeeName: string | null;
  lastEmailSentAt: string | null;
  fairSettlement: FairSettlement | null;
  orderAmountTotal: number | null;
}

interface GuestListProps {
  eventId: string;
  isOwner: boolean;
}

function formatCurrency(cents: number | null, currency: string | null): string {
  if (cents === null) return '—';
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: currency || 'CAD',
  }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncateDid(did: string): string {
  if (did.length <= 20) return did;
  return `${did.slice(0, 16)}…`;
}

function ProfileCell({ ownerDid, profile, paymentMethod, paymentId }: {
  ownerDid: string | null;
  profile: Profile | null;
  paymentMethod?: string | null;
  paymentId?: string | null;
}) {
  const display = profile?.name || profile?.handle || (ownerDid ? truncateDid(ownerDid) : '—');
  const initials = display.charAt(0).toUpperCase();

  const paymentLabel =
    paymentMethod === 'stripe' ? '💳 Card'
    : paymentMethod === 'etransfer' ? '🏦 e-Transfer'
    : null;

  return (
    <div className="flex items-center gap-2 min-w-0">
      {profile?.avatar ? (
        <img
          src={profile.avatar}
          alt={display}
          className="w-8 h-8 rounded-full object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0 text-xs font-semibold text-white">
          {initials}
        </div>
      )}
      <div className="min-w-0">
        {profile?.name && (
          <p className="text-sm font-medium truncate">{profile.name}</p>
        )}
        {profile?.handle && (
          <p className="text-xs text-gray-400 truncate">@{profile.handle}</p>
        )}
        {!profile?.name && !profile?.handle && (
          <p className="text-xs text-gray-400 font-mono truncate">{ownerDid ? truncateDid(ownerDid) : '—'}</p>
        )}
        {paymentLabel && (
          paymentMethod === 'stripe' && paymentId ? (
            <a
              href={`https://dashboard.stripe.com/payments/${paymentId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-gray-300 transition"
            >
              {paymentLabel}
            </a>
          ) : (
            <p className="text-xs text-gray-400">{paymentLabel}</p>
          )
        )}
      </div>
    </div>
  );
}

type FilterKey = 'type' | 'status' | null;

export function GuestList({ eventId, isOwner }: GuestListProps) {
  const { toast } = useToast();
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState<FilterKey>(null);
  const [filterValue, setFilterValue] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmRefund, setConfirmRefund] = useState<string | null>(null);
  const [confirmETransfer, setConfirmETransfer] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [surveyModalTicketId, setSurveyModalTicketId] = useState<string | null>(null);
  const [surveyQuestions, setSurveyQuestions] = useState<Array<{ question: string; answer: unknown }>>([]);
  const [surveyLoading, setSurveyLoading] = useState(false);
  const [resendState, setResendState] = useState<Record<string, 'sending' | 'sent'>>({});
  const [resendToast, setResendToast] = useState<{ email: string } | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualRefundInfo, setManualRefundInfo] = useState<{ ticketId: string; email?: string; amount: string; currency: string } | null>(null);
  const [markSentLoading, setMarkSentLoading] = useState(false);
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch(`/api/events/${eventId}/guests`)
      .then(r => r.json())
      .then(data => {
        setGuests(data.guests || []);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load guest list');
        setLoading(false);
      });
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  const handleCheckIn = async (ticketId: string) => {
    setActionLoading(ticketId);
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets/${ticketId}/check-in`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Check-in failed');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, usedAt: data.ticket.usedAt } : g
      ));
    } catch {
      toast.error('Check-in failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleScannerCheckIn = useCallback((ticketId: string) => {
    setGuests(prev => prev.map(g =>
      g.id === ticketId ? { ...g, usedAt: g.usedAt ?? new Date().toISOString() } : g
    ));
  }, []);

  const handleConfirmETransfer = async (ticketId: string) => {
    setConfirmETransfer(null);
    setActionLoading(ticketId);
    try {
      const res = await apiFetch(`/api/tickets/${ticketId}/confirm-payment`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Confirmation failed');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, status: 'valid', purchasedAt: data.ticket.purchasedAt } : g
      ));
    } catch {
      toast.error('Confirmation failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleResendEmail = async (ticketId: string) => {
    setResendState(prev => ({ ...prev, [ticketId]: 'sending' }));
    const minWait = new Promise(resolve => setTimeout(resolve, 500));
    try {
      const [res] = await Promise.all([
        apiFetch(`/api/events/${eventId}/tickets/${ticketId}/resend-email`, { method: 'POST' }),
        minWait,
      ]);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to resend email');
        setResendState(prev => { const n = { ...prev }; delete n[ticketId]; return n; });
        return;
      }
      // Update the guest's lastEmailSentAt locally
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, lastEmailSentAt: data.lastEmailSentAt || new Date().toISOString() } : g
      ));
      setResendState(prev => ({ ...prev, [ticketId]: 'sent' }));
      setResendToast({ email: data.email });
      setTimeout(() => setResendToast(null), 4000);
    } catch {
      toast.error('Failed to resend email');
      setResendState(prev => { const n = { ...prev }; delete n[ticketId]; return n; });
    }
  };

  const handleViewSurvey = async (ticketId: string) => {
    setSurveyModalTicketId(ticketId);
    setSurveyQuestions([]);
    setSurveyLoading(true);
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets/${ticketId}/registration`);
      const data = await res.json();
      if (res.ok) {
        setSurveyQuestions(data.questions || []);
      }
    } catch {
      // silently fail — modal still shows with empty state
    } finally {
      setSurveyLoading(false);
    }
  };

  const handleCancel = async (ticketId: string) => {
    setConfirmCancel(null);
    setActionLoading(ticketId);
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets/${ticketId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Cancel failed');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, status: 'cancelled' } : g
      ));
      toast.success('Ticket cancelled');
    } catch {
      toast.error('Cancel failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefund = async (ticketId: string) => {
    setConfirmRefund(null);
    setActionLoading(ticketId);
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets/${ticketId}/refund`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Refund failed');
        return;
      }
      const newStatus = data.manualRefundRequired ? 'refund_pending' : 'refunded';
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, status: newStatus } : g
      ));
      if (data.manualRefundRequired) {
        setManualRefundInfo({
          ticketId,
          email: data.refundEmail,
          amount: data.refundAmount,
          currency: data.refundCurrency,
        });
      }
    } catch {
      toast.error('Refund failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleMarkRefundSent = async (ticketId: string) => {
    setMarkSentLoading(true);
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets/${ticketId}/mark-refund-sent`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to mark refund as sent');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, status: 'refunded' } : g
      ));
      setManualRefundInfo(null);
    } catch {
      toast.error('Failed to mark refund as sent');
    } finally {
      setMarkSentLoading(false);
    }
  };

  // Filter logic
  const toggleFilter = (key: FilterKey, value: string) => {
    if (filterKey === key && filterValue === value) {
      setFilterKey(null);
      setFilterValue(null);
    } else {
      setFilterKey(key);
      setFilterValue(value);
    }
  };

  const filteredGuests = guests.filter(g => {
    if (!filterKey) return true;
    if (filterKey === 'type') return g.ticketType === filterValue;
    if (filterKey === 'status') return g.status === filterValue;
    return true;
  });

  // Summary counts
  const typeCounts = guests.reduce<Record<string, number>>((acc, g) => {
    acc[g.ticketType] = (acc[g.ticketType] || 0) + 1;
    return acc;
  }, {});
  const statusCounts = guests.reduce<Record<string, number>>((acc, g) => {
    acc[g.status] = (acc[g.status] || 0) + 1;
    return acc;
  }, {});

  const uniqueTypes = Object.keys(typeCounts);
  const uniqueStatuses = Object.keys(statusCounts);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
        <h2 className="text-xl font-semibold mb-2">Guest List</h2>
        <p className="text-gray-500 text-sm">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
        <h2 className="text-xl font-semibold mb-2">Guest List</h2>
        <p className="text-red-500 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Guest List</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { window.location.href = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/api/events/${eventId}/guests/export.csv`; }}
              className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition border border-gray-200 dark:border-gray-600"
            >
              ⬇ Download CSV
            </button>
            <button
              onClick={() => setScannerOpen(v => !v)}
              className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition border border-gray-200 dark:border-gray-600"
            >
              {scannerOpen ? '✕ Close Scanner' : '📷 Scan Tickets'}
            </button>
          </div>
        </div>

        {scannerOpen && (
          <div className="mb-4">
            <TicketScanner
              eventId={eventId}
              onCheckIn={handleScannerCheckIn}
              lookupGuest={(id) => {
                const g = guests.find(g => g.id === id);
                return g ? { attendeeName: g.attendeeName, ticketType: g.ticketType } : undefined;
              }}
            />
          </div>
        )}

        {/* Summary badge */}
        {guests.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              {guests.length} ticket{guests.length !== 1 ? 's' : ''}
            </span>
            {uniqueTypes.map(type => (
              <button
                key={type}
                onClick={() => toggleFilter('type', type)}
                className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium transition ${
                  filterKey === 'type' && filterValue === type
                    ? 'bg-orange-500 text-white'
                    : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60'
                }`}
              >
                {type} ({typeCounts[type]})
              </button>
            ))}
            {uniqueStatuses.map(status => (
              <button
                key={status}
                onClick={() => toggleFilter('status', status)}
                className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium transition ${
                  filterKey === 'status' && filterValue === status
                    ? 'bg-orange-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {status} ({statusCounts[status]})
              </button>
            ))}
            {filterKey && (
              <button
                onClick={() => { setFilterKey(null); setFilterValue(null); }}
                className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/60 transition"
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      {guests.length === 0 ? (
        <p className="px-6 pb-6 text-gray-500 text-sm">No tickets sold yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Profile
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition"
                  onClick={() => filterKey === 'type' ? (setFilterKey(null), setFilterValue(null)) : null}
                >
                  Type
                  {filterKey === 'type' && (
                    <span className="ml-1 text-orange-500">▾</span>
                  )}
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition"
                  onClick={() => filterKey === 'status' ? (setFilterKey(null), setFilterValue(null)) : null}
                >
                  Status
                  {filterKey === 'status' && (
                    <span className="ml-1 text-orange-500">▾</span>
                  )}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Price
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Purchased
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Checked In
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Registration
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {filteredGuests.map(guest => (
                <Fragment key={guest.id}>
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3">
                    <ProfileCell ownerDid={guest.ownerDid} profile={guest.profile} paymentMethod={guest.paymentMethod} paymentId={guest.paymentId} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-sm text-gray-700 dark:text-gray-300">{guest.ticketType}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-0.5">{guest.id}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusBadge status={guest.status} paymentMethod={guest.paymentMethod} />
                    {guest.status === 'held' && guest.paymentMethod === 'etransfer' && (
                      <button
                        onClick={() => setConfirmETransfer(guest.id)}
                        disabled={actionLoading === guest.id}
                        className="mt-1 px-2 py-1 text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition disabled:opacity-50 block"
                      >
                        {actionLoading === guest.id ? '…' : 'Confirm'}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {formatCurrency(guest.pricePaid, guest.currency)}
                      {guest.fairSettlement && (
                        <button
                          onClick={() => setExpandedReceipt(prev => prev === guest.id ? null : guest.id)}
                          className="text-base leading-none hover:scale-110 transition-transform"
                          title=".fair settlement receipt"
                        >
                          ⚖️
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {formatDate(guest.purchasedAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {guest.usedAt ? formatDateTime(guest.usedAt) : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <RegistrationCell
                      status={guest.registrationStatus}
                      attendeeName={guest.attendeeName}
                      onViewSurvey={guest.registrationStatus === 'complete' ? () => handleViewSurvey(guest.id) : undefined}
                    />
                    {guest.status !== 'refunded' && guest.status !== 'refund_pending' && guest.status !== 'cancelled' && !guest.usedAt && (
                      <div className="mt-1">
                        <ResendEmailButton
                          loading={actionLoading === guest.id}
                          resendState={resendState[guest.id]}
                          lastEmailSentAt={guest.lastEmailSentAt}
                          onResendEmail={() => handleResendEmail(guest.id)}
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <ActionsCell
                      guest={guest}
                      isOwner={isOwner}
                      loading={actionLoading === guest.id}
                      onCheckIn={() => handleCheckIn(guest.id)}
                      onRefundRequest={() => setConfirmRefund(guest.id)}
                      onCancelRequest={() => setConfirmCancel(guest.id)}
                      onMarkSent={() => handleMarkRefundSent(guest.id)}
                      markSentLoading={markSentLoading}
                    />
                  </td>
                </tr>
                {expandedReceipt === guest.id && guest.fairSettlement && (
                  <tr className="bg-gray-50/50 dark:bg-gray-900/30">
                    <td colSpan={8} className="px-6 pb-3 pt-0">
                      <GuestFairReceipt settlement={guest.fairSettlement} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* e-Transfer confirmation dialog */}
      {confirmETransfer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-semibold mb-2">Confirm e-Transfer Payment</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Have you received the e-Transfer for ticket <span className="font-mono text-xs">{confirmETransfer}</span>?
              This will activate the ticket.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmETransfer(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirmETransfer(confirmETransfer)}
                className="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition"
              >
                Confirm Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Survey answers modal */}
      {surveyModalTicketId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-lg w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Registration Answers</h3>
              <button
                onClick={() => setSurveyModalTicketId(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {surveyLoading ? (
                <p className="text-sm text-gray-500">Loading...</p>
              ) : surveyQuestions.length === 0 ? (
                <p className="text-sm text-gray-500">No survey answers recorded.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {surveyQuestions.map((qa, i) => (
                      <tr key={i}>
                        <td className="py-2 pr-4 font-medium text-gray-700 dark:text-gray-300 w-2/5 align-top">{qa.question}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400 break-words">
                          {qa.answer === null || qa.answer === undefined
                            ? <span className="text-gray-400">—</span>
                            : typeof qa.answer === 'object'
                              ? JSON.stringify(qa.answer)
                              : String(qa.answer)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setSurveyModalTicketId(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resend email success toast */}
      {resendToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white px-4 py-3 rounded-lg shadow-lg text-sm flex items-center gap-2">
          <span className="text-green-400">✓</span>
          Email resent to {resendToast.email}
        </div>
      )}

      {/* Manual refund required dialog */}
      {manualRefundInfo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full border-2 border-amber-400 dark:border-amber-500">
            <h3 className="text-lg font-semibold mb-2 text-amber-700 dark:text-amber-400">🏦 Manual Refund Required</h3>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-6">
              Send{' '}
              <span className="font-semibold">${manualRefundInfo.amount} {manualRefundInfo.currency}</span>
              {' '}via e-transfer to{' '}
              {manualRefundInfo.email
                ? <span className="font-semibold">{manualRefundInfo.email}</span>
                : 'the buyer'}
              .
            </p>
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => setManualRefundInfo(null)}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
              >
                I&apos;ll do it later
              </button>
              <button
                onClick={() => handleMarkRefundSent(manualRefundInfo.ticketId)}
                disabled={markSentLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition disabled:opacity-50"
              >
                {markSentLoading ? '…' : 'Mark Refund Sent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel held ticket confirmation dialog */}
      {confirmCancel && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-semibold mb-2">Cancel Ticket</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Cancel this unconfirmed e-Transfer ticket? No payment was received, so there&apos;s nothing to refund.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmCancel(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                Keep
              </button>
              <button
                onClick={() => handleCancel(confirmCancel)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition"
              >
                Cancel Ticket
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund confirmation dialog */}
      {confirmRefund && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-semibold mb-2">Confirm Refund</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Are you sure you want to refund this ticket? This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmRefund(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRefund(confirmRefund)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition"
              >
                Refund
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const FAIR_ROLE_LABELS: Record<string, string> = {
  buyer_credit: 'Buyer credit',
  node: 'Node',
  platform: 'Protocol (MJN)',
  seller: 'Organizer',
  creator: 'Creator',
};

function truncateFairDid(did: string): string {
  return did.length > 16 ? did.slice(0, 10) + '…' + did.slice(-6) : did;
}

function GuestFairReceipt({ settlement }: { settlement: FairSettlement }) {
  const currencyFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: settlement.currency || 'CAD',
  });

  const netAmount = settlement.netAmount
    ?? settlement.chain.find(e => e.role === 'seller')?.amount
    ?? null;

  return (
    <div className="mt-1 mb-1 space-y-1.5 max-w-sm">
      {settlement.chain.map((entry, i) => (
        <div
          key={i}
          className="flex items-center justify-between px-3 py-1.5 bg-white dark:bg-gray-800 rounded-lg text-xs border border-gray-100 dark:border-gray-700"
        >
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
              entry.role === 'seller' ? 'bg-orange-500' :
              entry.role === 'buyer_credit' ? 'bg-green-500' :
              entry.role === 'platform' ? 'bg-blue-500' :
              'bg-gray-500'
            }`} />
            <span className="font-medium">{FAIR_ROLE_LABELS[entry.role] ?? entry.role}</span>
            <span className="text-gray-400 font-mono">{truncateFairDid(entry.did)}</span>
          </div>
          <span className="font-bold">{currencyFmt.format(entry.amount)}</span>
        </div>
      ))}
      {settlement.fees && settlement.fees.length > 0 && settlement.fees.map((fee, i) => (
        <div
          key={`fee-${i}`}
          className="flex items-center justify-between px-3 py-1.5 bg-white dark:bg-gray-800 rounded-lg text-xs border border-gray-100 dark:border-gray-700"
        >
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />
            <span className="font-medium text-gray-500">{fee.name}</span>
            <span className="text-gray-400">
              {(fee.rateBps / 100).toFixed(1)}%{fee.fixedCents > 0 ? ` + ${currencyFmt.format(fee.fixedCents / 100)}` : ''}
            </span>
          </div>
          <span className="font-bold text-gray-500">
            {fee.estimated ? '~' : ''}{currencyFmt.format(fee.amount)}
          </span>
        </div>
      ))}
      <div className="flex justify-between px-3 pt-1.5 border-t border-gray-200 dark:border-gray-700 text-xs">
        <span className="text-gray-500">Total paid</span>
        <span className="font-bold">{currencyFmt.format(settlement.totalAmount)}</span>
      </div>
      {netAmount !== null && (
        <div className="flex justify-between px-3 text-xs">
          <span className="text-gray-500">Organizer receives</span>
          <span className="font-bold text-orange-500">{currencyFmt.format(netAmount)}</span>
        </div>
      )}
      <p className="text-[10px] text-gray-400 px-3">
        Settled {new Date(settlement.settledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        {' · .fair v'}{settlement.version || '1.0'}
      </p>
    </div>
  );
}

function RegistrationCell({ status, attendeeName, onViewSurvey }: { status: string | null; attendeeName: string | null; onViewSurvey?: () => void }) {
  if (!status || status === 'not_required') {
    return <span className="text-xs text-gray-400">—</span>;
  }
  if (status === 'complete') {
    return (
      <div>
        <button
          onClick={onViewSurvey}
          disabled={!onViewSurvey}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60 transition disabled:cursor-default"
        >
          ✅ Registered
        </button>
        {attendeeName && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{attendeeName}</p>
        )}
      </div>
    );
  }
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
        ⏳ Pending
      </span>
    );
  }
  return <span className="text-xs text-gray-400">{status}</span>;
}

function StatusBadge({ status, paymentMethod }: { status: string; paymentMethod?: string | null }) {
  if (status === 'held' && paymentMethod === 'etransfer') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300">
        pending e-Transfer
      </span>
    );
  }
  switch (status) {
    case 'valid':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
          valid
        </span>
      );
    case 'refund_pending':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
          ⏳ refund pending
        </span>
      );
    case 'refunded':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
          refunded
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
          cancelled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
          {status}
        </span>
      );
  }
}

interface ActionsCellProps {
  guest: Guest;
  isOwner: boolean;
  loading: boolean;
  onCheckIn: () => void;
  onRefundRequest: () => void;
  onCancelRequest: () => void;
  onMarkSent: () => void;
  markSentLoading: boolean;
}

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

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

function ResendEmailButton({ loading, resendState, lastEmailSentAt, onResendEmail }: {
  loading: boolean;
  resendState?: 'sending' | 'sent';
  lastEmailSentAt: string | null;
  onResendEmail: () => void;
}) {
  const onCooldown = lastEmailSentAt && (Date.now() - new Date(lastEmailSentAt).getTime()) < COOLDOWN_MS;
  const isSending = resendState === 'sending';
  const isSent = resendState === 'sent';
  const disabled = loading || isSending || !!onCooldown;

  if (isSent && lastEmailSentAt) {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-green-600 dark:text-green-400">
        ✓ Sent {timeAgo(lastEmailSentAt)}
      </span>
    );
  }

  if (onCooldown && lastEmailSentAt) {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500" title={`Last sent ${new Date(lastEmailSentAt).toLocaleString()}`}>
        Sent {timeAgo(lastEmailSentAt)}
      </span>
    );
  }

  return (
    <button
      onClick={onResendEmail}
      disabled={disabled}
      className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 rounded-lg transition disabled:opacity-50"
    >
      {isSending ? 'Sending…' : lastEmailSentAt ? `Resend (${timeAgo(lastEmailSentAt)})` : 'Resend Email'}
    </button>
  );
}

function ActionsCell({ guest, isOwner, loading, onCheckIn, onRefundRequest, onCancelRequest, onMarkSent, markSentLoading }: ActionsCellProps) {
  const isValid = guest.status === 'valid';
  const isHeld = guest.status === 'held';
  const isCheckedIn = !!guest.usedAt;
  const isRefunded = guest.status === 'refunded';
  const isCancelled = guest.status === 'cancelled';
  const isRefundPending = guest.status === 'refund_pending';
  const isFree = !guest.pricePaid || guest.pricePaid === 0;

  if (isRefunded) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
        Refunded
      </span>
    );
  }

  if (isCancelled) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400">
        Cancelled
      </span>
    );
  }

  if (isRefundPending && isOwner) {
    return (
      <button
        onClick={onMarkSent}
        disabled={markSentLoading}
        className="px-3 py-1.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 text-amber-700 dark:text-amber-300 rounded-lg transition disabled:opacity-50"
      >
        {markSentLoading ? '…' : 'Mark Sent'}
      </button>
    );
  }

  if (isCheckedIn) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
        ✓ Checked In
      </span>
    );
  }

  if (isHeld && isOwner) {
    return (
      <button
        onClick={onCancelRequest}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-red-100 dark:hover:bg-red-900/40 text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 rounded-lg transition disabled:opacity-50"
      >
        {loading ? '…' : 'Cancel'}
      </button>
    );
  }

  if (!isValid) {
    return <span className="text-xs text-gray-400">—</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onCheckIn}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium bg-green-500 hover:bg-green-600 text-white rounded-lg transition disabled:opacity-50"
      >
        {loading ? '…' : 'Check In'}
      </button>
      {isOwner && !isFree && (
        <button
          onClick={onRefundRequest}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-red-100 dark:hover:bg-red-900/40 text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 rounded-lg transition disabled:opacity-50"
        >
          Refund
        </button>
      )}
    </div>
  );
}
