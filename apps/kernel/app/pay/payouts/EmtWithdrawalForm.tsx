'use client';

import { useState } from 'react';
import { useToast } from '@imajin/ui';

interface EmtWithdrawalFormProps {
  did: string;
  cashAmount: number;
  currency: string;
}

export function EmtWithdrawalForm({ cashAmount, currency }: EmtWithdrawalFormProps) {
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [emtEmail, setEmtEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const minWithdrawal = 10;
  const canWithdraw = cashAmount >= minWithdrawal;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }
    if (numAmount < minWithdrawal) {
      toast.error(`Minimum withdrawal is ${minWithdrawal} ${currency}`);
      return;
    }
    if (numAmount > cashAmount) {
      toast.error('Amount exceeds available cash balance');
      return;
    }
    if (!emtEmail || !emtEmail.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/pay/api/balance/withdraw/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: numAmount, emt_email: emtEmail }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        toast.success(`Withdrawal request submitted: ${data.requestId}`);
        setAmount('');
        setEmtEmail('');
      } else {
        toast.error(data.error || 'Withdrawal request failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <h2 className="text-xl font-semibold text-white mb-2">Request EMT Withdrawal</h2>
      <p className="text-zinc-400 text-sm mb-4">
        Withdraw cash balance via Interac e-Transfer. Minimum ${minWithdrawal} {currency}.
      </p>

      <div className="mb-4 flex items-center justify-between text-sm">
        <span className="text-zinc-500">Available cash</span>
        <span className="text-white font-medium">
          {new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cashAmount)}
        </span>
      </div>

      {!canWithdraw && (
        <div className="mb-4 rounded-lg bg-amber-900/30 text-amber-400 px-4 py-2 text-sm">
          You need at least ${minWithdrawal} {currency} to request a withdrawal.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Amount ({currency})</label>
          <input
            type="number"
            step="0.01"
            min={minWithdrawal}
            max={cashAmount}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Minimum ${minWithdrawal}`}
            disabled={!canWithdraw || loading}
            className="w-full rounded-lg border border-zinc-700 bg-black/40 text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">EMT Email</label>
          <input
            type="email"
            value={emtEmail}
            onChange={(e) => setEmtEmail(e.target.value)}
            placeholder="your@email.com"
            disabled={!canWithdraw || loading}
            className="w-full rounded-lg border border-zinc-700 bg-black/40 text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
          />
        </div>
        <button
          type="submit"
          disabled={!canWithdraw || loading}
          className="w-full rounded-lg bg-orange-600 hover:bg-orange-500 disabled:bg-orange-700 disabled:opacity-50 text-white px-4 py-2.5 text-sm font-medium transition-colors"
        >
          {loading ? 'Submitting…' : 'Request Withdrawal'}
        </button>
      </form>
    </div>
  );
}
