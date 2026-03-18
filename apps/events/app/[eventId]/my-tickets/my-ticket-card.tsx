'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  ticketId: string;
  eventId: string;
  ticketTypeName: string;
  pricePaid: number | null;
  currency: string | null;
  purchasedAt: string | null;
  registrationStatus: string;
  registrationFormId: string | null;
  registration: { name: string; email: string } | null;
  qrCodeDataUri?: string;
  autoExpand: boolean;
}

export function MyTicketCard({
  ticketId,
  eventId,
  ticketTypeName,
  pricePaid,
  currency,
  purchasedAt,
  registrationStatus,
  registrationFormId,
  registration,
  qrCodeDataUri,
  autoExpand,
}: Props) {
  const [formOpen, setFormOpen] = useState(autoExpand);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (autoExpand && ref.current) {
      setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [autoExpand]);

  const formattedPrice =
    pricePaid !== null && currency
      ? pricePaid === 0
        ? 'Free'
        : new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(pricePaid / 100)
      : null;

  const formattedDate = purchasedAt
    ? new Date(purchasedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  const isPending = registrationStatus === 'pending';
  const isComplete = registrationStatus === 'complete';

  const borderClass = isPending
    ? 'border-yellow-400 dark:border-yellow-500'
    : isComplete
    ? 'border-green-500 dark:border-green-500'
    : 'border-orange-500 dark:border-orange-500';

  const bgClass = isPending
    ? 'bg-yellow-50/30 dark:bg-yellow-900/5'
    : isComplete
    ? 'bg-green-50/30 dark:bg-green-900/5'
    : 'bg-orange-50/30 dark:bg-orange-900/5';

  return (
    <div ref={ref} className={`rounded-2xl border-2 overflow-hidden ${borderClass} ${bgClass}`}>
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold">{ticketTypeName}</h2>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {formattedPrice && (
                <span className="text-sm text-gray-500 dark:text-gray-400">{formattedPrice}</span>
              )}
              {formattedDate && (
                <span className="text-sm text-gray-400">📅 {formattedDate}</span>
              )}
            </div>
            <p className="font-mono text-[10px] text-gray-400 mt-0.5">{ticketId}</p>
          </div>
          <RegistrationBadge status={registrationStatus} />
        </div>

        {/* Completed: show attendee info + QR */}
        {isComplete && (
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            {registration && (
              <div className="flex-1">
                <div className="p-3 bg-gray-100 dark:bg-gray-700/50 rounded-xl">
                  <p className="font-semibold">{registration.name}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{registration.email}</p>
                </div>
              </div>
            )}
            {qrCodeDataUri && (
              <div className="bg-gray-900 dark:bg-[#0a0a0a] border border-gray-700 rounded-xl p-3 text-center flex-shrink-0">
                <img
                  src={qrCodeDataUri}
                  alt="Ticket QR Code"
                  width={140}
                  height={140}
                  className="mx-auto mb-1"
                />
                <p className="font-mono text-[9px] text-gray-400">{ticketId}</p>
              </div>
            )}
          </div>
        )}

        {/* Not required: show QR only */}
        {!isPending && !isComplete && qrCodeDataUri && (
          <div className="flex justify-center">
            <div className="bg-gray-900 dark:bg-[#0a0a0a] border border-gray-700 rounded-xl p-3 text-center">
              <img
                src={qrCodeDataUri}
                alt="Ticket QR Code"
                width={140}
                height={140}
                className="mx-auto mb-1"
              />
              <p className="font-mono text-[9px] text-gray-400">{ticketId}</p>
            </div>
          </div>
        )}

        {/* Pending: Complete Registration button */}
        {isPending && (
          <button
            onClick={() => setFormOpen(!formOpen)}
            className="mt-2 w-full py-2.5 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition text-sm"
          >
            {formOpen ? '✕ Close' : '📝 Complete Registration'}
          </button>
        )}
      </div>

      {/* Inline registration form */}
      {isPending && formOpen && (
        <div className="border-t border-yellow-200 dark:border-yellow-900/30 px-6 pb-6 pt-4 bg-white/50 dark:bg-gray-800/50">
          <InlineRegForm
            ticketId={ticketId}
            registrationFormId={registrationFormId}
            onSuccess={() => router.refresh()}
          />
        </div>
      )}
    </div>
  );
}

function RegistrationBadge({ status }: { status: string }) {
  if (status === 'complete') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 whitespace-nowrap flex-shrink-0">
        ✅ Registered
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400 whitespace-nowrap flex-shrink-0">
        ⏳ Registration Required
      </span>
    );
  }
  return null;
}

interface InlineRegFormProps {
  ticketId: string;
  registrationFormId: string | null;
  onSuccess: () => void;
}

function InlineRegForm({ ticketId, registrationFormId, onSuccess }: InlineRegFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/register/${ticketId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), formId: registrationFormId || 'none' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed. Please try again.');
        return;
      }
      onSuccess();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor={`name-${ticketId}`}>
          Full Name *
        </label>
        <input
          id={`name-${ticketId}`}
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Smith"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500 focus:outline-none text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor={`email-${ticketId}`}>
          Email *
        </label>
        <input
          id={`email-${ticketId}`}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@example.com"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500 focus:outline-none text-sm"
        />
      </div>
      {registrationFormId && (
        <div className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-dashed border-gray-300 dark:border-gray-600">
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
            Additional registration questions will appear here.
          </p>
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full py-2.5 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-semibold rounded-lg transition text-sm"
      >
        {loading ? 'Registering...' : 'Complete Registration'}
      </button>
    </form>
  );
}
