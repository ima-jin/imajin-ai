'use client';

import { useState, useEffect, useCallback } from 'react';

interface Profile {
  name: string | null;
  handle: string | null;
  avatar: string | null;
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
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState<FilterKey>(null);
  const [filterValue, setFilterValue] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmRefund, setConfirmRefund] = useState<string | null>(null);
  const [confirmETransfer, setConfirmETransfer] = useState<string | null>(null);
  const [surveyModalTicketId, setSurveyModalTicketId] = useState<string | null>(null);
  const [surveyQuestions, setSurveyQuestions] = useState<Array<{ question: string; answer: unknown }>>([]);
  const [surveyLoading, setSurveyLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState<string | null>(null);
  const [resendToast, setResendToast] = useState<{ email: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/events/${eventId}/guests`)
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
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketId}/check-in`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Check-in failed');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, usedAt: data.ticket.usedAt } : g
      ));
    } catch {
      alert('Check-in failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirmETransfer = async (ticketId: string) => {
    setConfirmETransfer(null);
    setActionLoading(ticketId);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/confirm-payment`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Confirmation failed');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, status: 'valid', purchasedAt: data.ticket.purchasedAt } : g
      ));
    } catch {
      alert('Confirmation failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleResendEmail = async (ticketId: string) => {
    setResendLoading(ticketId);
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketId}/resend-email`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to resend email');
        return;
      }
      setResendToast({ email: data.email });
      setTimeout(() => setResendToast(null), 4000);
    } catch {
      alert('Failed to resend email');
    } finally {
      setResendLoading(null);
    }
  };

  const handleViewSurvey = async (ticketId: string) => {
    setSurveyModalTicketId(ticketId);
    setSurveyQuestions([]);
    setSurveyLoading(true);
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketId}/registration`);
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

  const handleRefund = async (ticketId: string) => {
    setConfirmRefund(null);
    setActionLoading(ticketId);
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketId}/refund`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Refund failed');
        return;
      }
      setGuests(prev => prev.map(g =>
        g.id === ticketId ? { ...g, status: 'refunded' } : g
      ));
    } catch {
      alert('Refund failed');
    } finally {
      setActionLoading(null);
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
        <h2 className="text-xl font-semibold mb-3">Guest List</h2>

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
                <tr key={guest.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3">
                    <ProfileCell ownerDid={guest.ownerDid} profile={guest.profile} paymentMethod={guest.paymentMethod} paymentId={guest.paymentId} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {guest.ticketType}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusBadge status={guest.status} paymentMethod={guest.paymentMethod} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {formatCurrency(guest.pricePaid, guest.currency)}
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
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <ActionsCell
                      guest={guest}
                      isOwner={isOwner}
                      loading={actionLoading === guest.id}
                      resendLoading={resendLoading === guest.id}
                      confirmRefund={confirmRefund === guest.id}
                      onCheckIn={() => handleCheckIn(guest.id)}
                      onRefundRequest={() => setConfirmRefund(guest.id)}
                      onRefundConfirm={() => handleRefund(guest.id)}
                      onRefundCancel={() => setConfirmRefund(null)}
                      onConfirmETransfer={() => setConfirmETransfer(guest.id)}
                      onResendEmail={() => handleResendEmail(guest.id)}
                    />
                  </td>
                </tr>
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
  resendLoading: boolean;
  confirmRefund: boolean;
  onCheckIn: () => void;
  onRefundRequest: () => void;
  onRefundConfirm: () => void;
  onRefundCancel: () => void;
  onConfirmETransfer: () => void;
  onResendEmail: () => void;
}

function ActionsCell({ guest, isOwner, loading, resendLoading, onCheckIn, onRefundRequest, onConfirmETransfer, onResendEmail }: ActionsCellProps) {
  const isValid = guest.status === 'valid';
  const isCheckedIn = !!guest.usedAt;
  const isRefunded = guest.status === 'refunded';
  const isFree = !guest.pricePaid || guest.pricePaid === 0;
  const isPendingETransfer = guest.status === 'held' && guest.paymentMethod === 'etransfer';

  if (isRefunded) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
        Refunded
      </span>
    );
  }

  if (isCheckedIn) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
        ✓ Checked In
      </span>
    );
  }

  if (isPendingETransfer) {
    return (
      <button
        onClick={onConfirmETransfer}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition disabled:opacity-50"
      >
        {loading ? '…' : 'Confirm e-Transfer'}
      </button>
    );
  }

  if (!isValid) {
    return <span className="text-xs text-gray-400">—</span>;
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={onCheckIn}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium bg-green-500 hover:bg-green-600 text-white rounded-lg transition disabled:opacity-50"
      >
        {loading ? '…' : 'Check In'}
      </button>
      <button
        onClick={onResendEmail}
        disabled={loading || resendLoading}
        className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 rounded-lg transition disabled:opacity-50"
      >
        {resendLoading ? '…' : 'Resend Email'}
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
