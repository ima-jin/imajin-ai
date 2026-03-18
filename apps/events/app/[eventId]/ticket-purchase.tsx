'use client';

import { useState } from 'react';
import type { TicketType } from '@/src/db/schema';

interface Props {
  eventId: string;
  eventTitle: string;
  ticket: TicketType;
  inviteToken?: string;
  etransferEnabled?: boolean;
}

interface ETransferInstructions {
  ticketId: string;
  email: string;
  amount: number;
  currency: string;
  memo: string;
  deadline: string;
  message: string;
}

type Step = 'button' | 'selector' | 'loading-card' | 'etransfer-confirm' | 'loading-etransfer' | 'etransfer-done';

export function TicketPurchase({ eventId, eventTitle, ticket, inviteToken, etransferEnabled = false }: Props) {
  const [step, setStep] = useState<Step>('button');
  const [error, setError] = useState<string | null>(null);
  const [etransfer, setEtransfer] = useState<ETransferInstructions | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const available = ticket.quantity === null
    ? 'Unlimited'
    : `${ticket.quantity - (ticket.sold ?? 0)} left`;

  const soldOut = ticket.quantity !== null && (ticket.sold ?? 0) >= ticket.quantity;

  const handleCardPayment = async () => {
    setStep('loading-card');
    setError(null);

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          ticketTypeId: ticket.id,
          quantity: 1,
          ...(inviteToken && { invite: inviteToken }),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create checkout');
      }

      const { url } = await response.json();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStep('selector');
    }
  };

  const handleETransfer = async () => {
    setStep('loading-etransfer');
    setError(null);

    try {
      const response = await fetch('/api/checkout/etransfer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          ticketTypeId: ticket.id,
          ...(inviteToken && { invite: inviteToken }),
          ...(email && { email: email.trim() }),
          ...(name && { name: name.trim() }),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create e-Transfer hold');
      }

      const data = await response.json();
      setEtransfer({
        ticketId: data.ticketId,
        email: data.instructions.email,
        amount: data.instructions.amount,
        currency: data.instructions.currency,
        memo: data.instructions.memo,
        deadline: data.instructions.deadline,
        message: data.instructions.message,
      });
      setStep('etransfer-done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStep('selector');
    }
  };

  const formatPrice = (cents: number, currency: string) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
    }).format(cents / 100);
  };

  const formatDeadline = (iso: string) => {
    return new Date(iso).toLocaleString('en-CA', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  };

  if (soldOut) {
    return (
      <button
        disabled
        className="px-6 md:px-8 py-2.5 md:py-3 rounded-lg font-semibold whitespace-nowrap bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
      >
        Sold Out
      </button>
    );
  }

  if (step === 'etransfer-done' && etransfer) {
    return (
      <div className="w-full max-w-md rounded-xl border border-orange-500/30 bg-orange-500/5 dark:bg-orange-500/10 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-orange-500 text-xl">📬</span>
          <h3 className="font-semibold text-base">Send your Interac e-Transfer</h3>
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex justify-between items-center py-2 border-b border-gray-200 dark:border-gray-700">
            <span className="text-gray-500 dark:text-gray-400">Amount</span>
            <span className="font-semibold text-base">
              {new Intl.NumberFormat('en-CA', { style: 'currency', currency: etransfer.currency }).format(etransfer.amount)}
            </span>
          </div>
          <div className="flex justify-between items-center py-2 border-b border-gray-200 dark:border-gray-700">
            <span className="text-gray-500 dark:text-gray-400">Send to</span>
            <span className="font-mono font-medium">{etransfer.email}</span>
          </div>
          <div className="flex justify-between items-center py-2 border-b border-gray-200 dark:border-gray-700">
            <span className="text-gray-500 dark:text-gray-400">Required memo</span>
            <span className="font-mono font-semibold text-orange-500">{etransfer.memo}</span>
          </div>
          <div className="flex justify-between items-center py-2">
            <span className="text-gray-500 dark:text-gray-400">Pay by</span>
            <span className="font-medium">{formatDeadline(etransfer.deadline)}</span>
          </div>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
          {etransfer.message}
        </p>

        <p className="text-xs text-gray-400">
          Ticket ID: <span className="font-mono">{etransfer.ticketId}</span>
        </p>
      </div>
    );
  }

  if (step === 'etransfer-confirm' || step === 'loading-etransfer') {
    return (
      <div className="w-full max-w-md rounded-xl border border-orange-500/30 bg-orange-500/5 dark:bg-orange-500/10 p-5 space-y-4">
        <h3 className="font-semibold text-base">🏦 Pay by Interac e-Transfer</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          You&apos;ll need to send <span className="font-semibold">{formatPrice(ticket.price, ticket.currency)}</span> via
          Interac e-Transfer within 72 hours. Your ticket will be held until payment is confirmed.
        </p>
        <div className="space-y-2">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={step === 'loading-etransfer'}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50"
          />
          <input
            type="email"
            placeholder="Your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={step === 'loading-etransfer'}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleETransfer}
            disabled={step === 'loading-etransfer' || !email.includes('@')}
            className={`px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap ${
              step === 'loading-etransfer'
                ? 'bg-orange-400 text-white cursor-wait'
                : !email.includes('@')
                ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                : 'bg-orange-500 text-white hover:bg-orange-600'
            }`}
          >
            {step === 'loading-etransfer' ? 'Reserving...' : 'Reserve My Ticket'}
          </button>
          <button
            onClick={() => { setStep('selector'); setError(null); }}
            disabled={step === 'loading-etransfer'}
            className="px-3 py-2.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition disabled:opacity-50"
          >
            Back
          </button>
        </div>
        {error && <p className="text-red-500 text-xs">{error}</p>}
      </div>
    );
  }

  if (step === 'selector' || step === 'loading-card') {
    return (
      <div className="space-y-2">
        {error && <p className="text-red-500 text-xs">{error}</p>}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={handleCardPayment}
            disabled={step === 'loading-card'}
            className={`px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap ${
              step === 'loading-card'
                ? 'bg-orange-400 text-white cursor-wait'
                : 'bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50'
            }`}
          >
            {step === 'loading-card' ? 'Loading...' : '💳 Pay with Card'}
          </button>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setStep('etransfer-confirm')}
              disabled={step === 'loading-card'}
              className="px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap bg-orange-500/20 text-orange-500 border border-orange-500/40 hover:bg-orange-500/30 disabled:opacity-50"
            >
              🏦 Pay by e-Transfer
            </button>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              e-Transfer payments go directly to the event organizer. Refunds are handled between you and the organizer.
            </p>
          </div>
          <button
            onClick={() => { setStep('button'); setError(null); }}
            disabled={step === 'loading-card'}
            className="px-3 py-2.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Default: 'button' step
  return (
    <>
      {error && (
        <p className="text-red-500 text-xs mb-2">{error}</p>
      )}
      <button
        onClick={() => etransferEnabled ? setStep('selector') : handleCardPayment()}
        className="px-6 md:px-8 py-2.5 md:py-3 rounded-lg font-semibold transition whitespace-nowrap bg-orange-500 text-white hover:bg-orange-600"
      >
        Get Ticket
      </button>
    </>
  );
}
