'use client';

import { useState } from 'react';
import { useToast } from '@imajin/ui';
import { apiFetch } from '@imajin/config';

interface FundDirection {
  id: string;
  label: string;
  description: string;
}

interface TipFormProps {
  page: {
    handle: string;
    presets: number[];
    fundDirections?: FundDirection[];
    allowCustomAmount: boolean;
    allowMessages: boolean;
    paymentMethods: {
      stripe?: { enabled: boolean };
      solana?: { enabled: boolean; address?: string };
    };
  };
  primaryColor: string;
  sellerConnected?: boolean;
}

export default function TipForm({ page, primaryColor, sellerConnected = true }: TipFormProps) {
  const { toast } = useToast();
  const [selectedAmount, setSelectedAmount] = useState<number | null>(page.presets?.[1] || 500);
  const [customAmount, setCustomAmount] = useState('');
  const [message, setMessage] = useState('');
  const [fromName, setFromName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'solana'>(
    page.paymentMethods.stripe?.enabled && sellerConnected ? 'stripe' : 'solana'
  );
  const [isRecurring, setIsRecurring] = useState(false);
  const [fundDirection, setFundDirection] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const fundDirections = page.fundDirections || [];

  const presets = page.presets || [100, 500, 1000];
  const hasStripe = page.paymentMethods.stripe?.enabled;
  const hasSolana = page.paymentMethods.solana?.enabled;
  // Stripe only available when the page owner has completed Stripe Connect setup
  const stripeAvailable = hasStripe && sellerConnected;

  const getAmount = () => {
    if (customAmount) {
      return Math.round(parseFloat(customAmount) * 100);
    }
    return selectedAmount || 0;
  };

  const formatAmount = (cents: number) => {
    return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const amount = getAmount();
    if (amount < 100) {
      setError('Minimum tip is $1');
      setIsLoading(false);
      return;
    }

    try {
      const response = await apiFetch('/api/tip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageHandle: page.handle,
          amount,
          currency: 'USD',
          recurring: isRecurring,
          paymentMethod,
          message: page.allowMessages ? message : undefined,
          fromName: fromName || undefined,
          fundDirection: fundDirection || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to process tip');
      }

      if (paymentMethod === "stripe" && data.url) {
        // Redirect to Stripe Checkout
        window.location.href = data.url;
      } else if (paymentMethod === 'solana' && data.solanaAddress) {
        // Show Solana address for payment
        toast.info(`Send ${amount / 100} USD worth of SOL to: ${data.solanaAddress}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* One-time vs Monthly Toggle */}
      <div className="flex justify-center">
        <div className="inline-flex bg-surface-card/50 p-1">
          <button
            type="button"
            onClick={() => setIsRecurring(false)}
            className={`px-6 py-2 font-medium transition ${ !isRecurring ? 'bg-surface-card text-primary' : 'text-secondary' }`}
          >
            One-time
          </button>
          <button
            type="button"
            onClick={() => setIsRecurring(true)}
            className={`px-6 py-2 font-medium transition ${ isRecurring ? 'bg-surface-card text-primary' : 'text-secondary' }`}
          >
            Monthly
          </button>
        </div>
      </div>

      {/* Amount Presets */}
      <div className="flex justify-center gap-3 flex-wrap">
        {presets.map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => {
              setSelectedAmount(amount);
              setCustomAmount('');
            }}
            className={`px-6 py-3 font-semibold transition-all ${ selectedAmount === amount && !customAmount ? 'text-primary scale-105' : 'bg-surface-card/50:bg-surface-card/80 text-muted' }`}
            style={
              selectedAmount === amount && !customAmount
                ? { backgroundColor: primaryColor }
                : {}
            }
          >
            {formatAmount(amount)}
            {isRecurring && <span className="text-xs block opacity-75">/month</span>}
          </button>
        ))}
      </div>

      {/* Custom Amount */}
      {page.allowCustomAmount && (
        <div>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-secondary">$</span>
            <input
              type="number"
              step="0.01"
              min="1"
              placeholder="Custom amount"
              value={customAmount}
              onChange={(e) => {
                setCustomAmount(e.target.value);
                setSelectedAmount(null);
              }}
              className="w-full pl-8 pr-4 py-3 border border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-surface-card/50"
            />
          </div>
        </div>
      )}

      {/* Fund Direction */}
      {fundDirections.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted text-center">Where should this go?</p>
          <div className="flex flex-wrap justify-center gap-2">
            {fundDirections.map((fd) => (
              <button
                key={fd.id}
                type="button"
                onClick={() => setFundDirection(fundDirection === fd.id ? '' : fd.id)}
                className={`px-4 py-2 text-sm font-medium transition-all ${ fundDirection === fd.id ? 'text-primary scale-105' : 'bg-surface-card/50:bg-surface-card/80 text-muted' }`}
                style={fundDirection === fd.id ? { backgroundColor: primaryColor } : {}}
                title={fd.description}
              >
                {fd.label}
              </button>
            ))}
          </div>
          {fundDirection && fundDirections.find(d => d.id === fundDirection)?.description && (
            <p className="text-xs text-secondary text-center italic">
              {fundDirections.find(d => d.id === fundDirection)?.description}
            </p>
          )}
        </div>
      )}

      {/* Message */}
      {page.allowMessages && (
        <div>
          <textarea
            placeholder="Add a message (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            className="w-full px-4 py-3 border border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-surface-card/50 resize-none"
          />
        </div>
      )}

      {/* From Name */}
      <div>
        <input
          type="text"
          placeholder="Your name (optional)"
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          className="w-full px-4 py-3 border border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-surface-card/50"
        />
      </div>

      {/* Payment Method Toggle */}
      {stripeAvailable && hasSolana && (
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => setPaymentMethod('stripe')}
            className={`px-4 py-2 text-sm font-medium transition ${ paymentMethod === 'stripe' ? 'bg-surface-surface text-primary' : 'bg-surface-elevated text-muted:bg-surface-elevated' }`}
          >
            💳 Card
          </button>
          <button
            type="button"
            onClick={() => setPaymentMethod('solana')}
            className={`px-4 py-2 text-sm font-medium transition ${ paymentMethod === 'solana' ? 'bg-purple-600 text-primary' : 'bg-surface-elevated text-muted:bg-surface-elevated' }`}
          >
            ◎ Solana
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-error text-sm text-center">{error}</p>
      )}

      {/* Submit or unavailable message */}
      {!stripeAvailable && !hasSolana ? (
        <p className="text-center text-sm text-secondary italic py-2">
          Payments not yet available
        </p>
      ) : (
        <button
          type="submit"
          disabled={isLoading || getAmount() < 100}
          className="w-full py-4 text-primary font-semibold text-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: primaryColor }}
        >
          {isLoading
            ? 'Processing...'
            : isRecurring
              ? `☕ Support with ${formatAmount(getAmount())}/month`
              : `☕ Send ${formatAmount(getAmount())}`
          }
        </button>
      )}
    </form>
  );
}
