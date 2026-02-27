'use client';

import { useState } from 'react';

interface TipFormProps {
  page: {
    handle: string;
    presets: number[];
    allowCustomAmount: boolean;
    allowMessages: boolean;
    paymentMethods: {
      stripe?: { enabled: boolean };
      solana?: { enabled: boolean; address?: string };
    };
  };
  primaryColor: string;
}

export default function TipForm({ page, primaryColor }: TipFormProps) {
  const [selectedAmount, setSelectedAmount] = useState<number | null>(page.presets?.[1] || 500);
  const [customAmount, setCustomAmount] = useState('');
  const [message, setMessage] = useState('');
  const [fromName, setFromName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'solana'>(
    page.paymentMethods.stripe?.enabled ? 'stripe' : 'solana'
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const presets = page.presets || [100, 500, 1000];
  const hasStripe = page.paymentMethods.stripe?.enabled;
  const hasSolana = page.paymentMethods.solana?.enabled;

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
      const response = await fetch('/api/tip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageHandle: page.handle,
          amount,
          currency: 'USD',
          paymentMethod,
          message: page.allowMessages ? message : undefined,
          fromName: fromName || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to process tip');
      }

      if (paymentMethod === 'stripe' && data.clientSecret) {
        // Redirect to Stripe checkout or show Stripe Elements
        // For now, show a message (full Stripe integration needs Elements)
        alert('Stripe payment initiated! Client secret: ' + data.clientSecret.slice(0, 20) + '...');
      } else if (paymentMethod === 'solana' && data.solanaAddress) {
        // Show Solana address for payment
        alert(`Send ${amount / 100} USD worth of SOL to:\n${data.solanaAddress}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
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
            className={`px-6 py-3 rounded-xl font-semibold transition-all ${
              selectedAmount === amount && !customAmount
                ? 'text-white shadow-lg scale-105'
                : 'bg-white/50 hover:bg-white/80 text-gray-700'
            }`}
            style={
              selectedAmount === amount && !customAmount
                ? { backgroundColor: primaryColor }
                : {}
            }
          >
            {formatAmount(amount)}
          </button>
        ))}
      </div>

      {/* Custom Amount */}
      {page.allowCustomAmount && (
        <div>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
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
              className="w-full pl-8 pr-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white/50"
            />
          </div>
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
            className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white/50 resize-none"
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
          className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white/50"
        />
      </div>

      {/* Payment Method Toggle */}
      {hasStripe && hasSolana && (
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => setPaymentMethod('stripe')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              paymentMethod === 'stripe'
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            💳 Card
          </button>
          <button
            type="button"
            onClick={() => setPaymentMethod('solana')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              paymentMethod === 'solana'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            ◎ Solana
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-red-500 text-sm text-center">{error}</p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isLoading || getAmount() < 100}
        className="w-full py-4 rounded-xl text-white font-semibold text-lg transition-all hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: primaryColor }}
      >
        {isLoading ? 'Processing...' : `☕ Send ${formatAmount(getAmount())}`}
      </button>
    </form>
  );
}
