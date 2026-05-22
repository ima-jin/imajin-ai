'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { STRIPE_RATE_BPS, STRIPE_FIXED_CENTS } from '@imajin/fair';

const PRESET_AMOUNTS = [20, 50, 100, 250, 1000];
const MIN_TOPUP = 20;

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
  }).format(n);
}

function calcStripeCharge(amount: number, userAbsorbs: boolean): number {
  const amountCents = Math.round(amount * 100);
  if (userAbsorbs) {
    return Math.ceil((amountCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_RATE_BPS / 10000)) / 100;
  }
  return amount;
}

function calcStripeFee(amount: number, userAbsorbs: boolean): number {
  const charge = calcStripeCharge(amount, userAbsorbs);
  return charge - amount;
}

type Step = 1 | 2 | 3;
type Method = 'stripe' | 'emt';

export default function TopupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [amount, setAmount] = useState<number>(50);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [method, setMethod] = useState<Method>('stripe');
  const [absorbFees, setAbsorbFees] = useState<boolean>(true); // true = platform absorbs
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [emtInstructions, setEmtInstructions] = useState<{
    email: string;
    amount: number;
    memo: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Auth check on mount
  useEffect(() => {
    fetch('/api/session', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) {
          const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
          const payUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
          globalThis.location.href = `${authUrl}/login?next=${encodeURIComponent(`${payUrl}/topup`)}`;
          return;
        }
        setSessionChecked(true);
      })
      .catch(() => {
        setSessionChecked(true);
      });
  }, []);

  const handlePresetClick = useCallback((val: number) => {
    setAmount(val);
    setCustomAmount('');
    setError(null);
  }, []);

  const handleCustomChange = useCallback((val: string) => {
    setCustomAmount(val);
    const num = Number.parseFloat(val);
    if (!isNaN(num) && num > 0) {
      setAmount(num);
    }
    setError(null);
  }, []);

  const canProceedStep1 = amount >= MIN_TOPUP;

  const handleProceedToStep2 = useCallback(() => {
    if (!canProceedStep1) {
      setError(`Minimum top-up is $${MIN_TOPUP}`);
      return;
    }
    setError(null);
    setStep(2);
  }, [canProceedStep1]);

  const handleProceedToStep3 = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      if (method === 'stripe') {
        const res = await fetch('/pay/api/topup/stripe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            amount,
            absorbFees,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to create checkout session');
        }

        // Redirect to Stripe Checkout
        globalThis.location.href = data.url;
        return;
      }

      if (method === 'emt') {
        const res = await fetch('/pay/api/topup/emt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ amount }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to create EMT request');
        }

        setEmtInstructions(data.instructions);
        setStep(3);
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [amount, method, absorbFees]);

  const handleCopyMemo = useCallback(() => {
    if (emtInstructions?.memo) {
      navigator.clipboard.writeText(emtInstructions.memo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [emtInstructions]);

  if (!sessionChecked) {
    return (
      <div className="max-w-xl mx-auto pt-12 text-center">
        <div className="text-zinc-500">Checking session...</div>
      </div>
    );
  }

  const stripeCharge = calcStripeCharge(amount, !absorbFees);
  const stripeFee = calcStripeFee(amount, !absorbFees);

  return (
    <div className="max-w-xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/pay" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-bold text-white">Add Funds</h1>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2">
        <div className={`flex-1 h-1 rounded-full ${step >= 1 ? 'bg-orange-500' : 'bg-zinc-800'}`} />
        <div className={`flex-1 h-1 rounded-full ${step >= 2 ? 'bg-orange-500' : 'bg-zinc-800'}`} />
        <div className={`flex-1 h-1 rounded-full ${step >= 3 ? 'bg-orange-500' : 'bg-zinc-800'}`} />
      </div>

      {/* Step 1 — Amount */}
      {step === 1 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-white mb-1">How much?</h2>
            <p className="text-sm text-zinc-500">Select an amount or enter your own (min $20)</p>
          </div>

          {/* Preset cards */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {PRESET_AMOUNTS.map((val) => (
              <button
                key={val}
                onClick={() => handlePresetClick(val)}
                className={`relative rounded-xl border px-3 py-4 text-center transition-all ${
                  amount === val && !customAmount
                    ? 'border-orange-500 bg-orange-500/10'
                    : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                }`}
              >
                <span className="text-sm font-semibold text-white">
                  {val >= 1000 ? `$${(val / 1000).toFixed(0)}k` : `$${val}`}
                </span>
              </button>
            ))}
          </div>

          {/* Custom amount */}
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 text-lg">$</span>
            <input
              type="number"
              min={MIN_TOPUP}
              step="0.01"
              placeholder="Custom amount"
              value={customAmount}
              onChange={(e) => handleCustomChange(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-4 text-white text-lg placeholder-zinc-600 focus:border-orange-500 focus:outline-none transition-colors"
            />
          </div>

          {error && (
            <div className="bg-red-900/20 border border-red-900/40 rounded-lg px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            onClick={handleProceedToStep2}
            disabled={!canProceedStep1}
            className="w-full px-4 py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-medium rounded-xl transition-colors"
          >
            Continue
          </button>
        </div>
      )}

      {/* Step 2 — Method + Fee Toggle */}
      {step === 2 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-white mb-1">Payment method</h2>
            <p className="text-sm text-zinc-500">Choose how you want to add funds</p>
          </div>

          {/* Fee toggle */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Who covers processing fees?</span>
              <span className="text-xs text-zinc-500">
                {absorbFees ? 'Platform' : 'Me'}
              </span>
            </div>
            <div className="flex bg-black/40 rounded-lg p-1">
              <button
                onClick={() => setAbsorbFees(false)}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                  !absorbFees
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Me
              </button>
              <button
                onClick={() => setAbsorbFees(true)}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                  absorbFees
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Platform
              </button>
            </div>
          </div>

          {/* Method cards */}
          <div className="space-y-3">
            {/* Stripe */}
            <button
              onClick={() => setMethod('stripe')}
              className={`w-full text-left rounded-xl border p-4 transition-all ${
                method === 'stripe'
                  ? 'border-orange-500 bg-orange-500/5'
                  : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-start gap-4">
                <div className="text-2xl shrink-0">💳</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">Credit / Debit Card</span>
                    <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">
                      Instant
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">Powered by Stripe</div>

                  {/* Breakdown */}
                  <div className="mt-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">You receive</span>
                      <span className="text-white font-medium">{fmtCurrency(amount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Processing fee</span>
                      <span className={stripeFee > 0 ? 'text-zinc-400' : 'text-green-400'}>
                        {stripeFee > 0 ? fmtCurrency(stripeFee) : 'Free'}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-zinc-800 pt-1.5">
                      <span className="text-zinc-400">You pay</span>
                      <span className="text-white font-semibold">{fmtCurrency(stripeCharge)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Credit to balance</span>
                      <span className="text-amber-400 font-medium">人{Math.round(amount)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </button>

            {/* EMT */}
            <button
              onClick={() => setMethod('emt')}
              className={`w-full text-left rounded-xl border p-4 transition-all ${
                method === 'emt'
                  ? 'border-orange-500 bg-orange-500/5'
                  : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-start gap-4">
                <div className="text-2xl shrink-0">🏦</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">Interac e-Transfer</span>
                    <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
                      Zero fees
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">Manual — admin matched</div>

                  {/* Breakdown */}
                  <div className="mt-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">You receive</span>
                      <span className="text-white font-medium">{fmtCurrency(amount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Processing fee</span>
                      <span className="text-green-400 font-medium">$0.00</span>
                    </div>
                    <div className="flex justify-between border-t border-zinc-800 pt-1.5">
                      <span className="text-zinc-400">You pay</span>
                      <span className="text-white font-semibold">{fmtCurrency(amount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Credit to balance</span>
                      <span className="text-amber-400 font-medium">人{Math.round(amount)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </button>
          </div>

          {error && (
            <div className="bg-red-900/20 border border-red-900/40 rounded-lg px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="px-5 py-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 font-medium rounded-xl transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleProceedToStep3}
              disabled={loading}
              className="flex-1 px-4 py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-medium rounded-xl transition-colors"
            >
              {loading ? 'Processing...' : method === 'stripe' ? 'Pay with Stripe →' : 'Confirm e-Transfer →'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — EMT Confirmation */}
      {step === 3 && method === 'emt' && emtInstructions && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="text-4xl mb-3">🏦</div>
            <h2 className="text-xl font-semibold text-white">Send your e-Transfer</h2>
            <p className="text-sm text-zinc-500 mt-1">
              Your balance will be credited once we receive and match your transfer.
            </p>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
            <div className="space-y-3">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Send to</div>
                <div className="flex items-center justify-between bg-black/40 rounded-lg px-4 py-3">
                  <span className="text-white font-mono text-sm">{emtInstructions.email}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(emtInstructions.email);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="text-xs text-orange-500 hover:text-orange-400 transition-colors"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs text-zinc-500 mb-1">Amount</div>
                <div className="bg-black/40 rounded-lg px-4 py-3 text-white font-medium">
                  {fmtCurrency(emtInstructions.amount)}
                </div>
              </div>

              <div>
                <div className="text-xs text-zinc-500 mb-1">Message / Memo</div>
                <div className="flex items-center justify-between bg-black/40 rounded-lg px-4 py-3">
                  <span className="text-white font-mono text-sm">{emtInstructions.memo}</span>
                  <button
                    onClick={handleCopyMemo}
                    className="text-xs text-orange-500 hover:text-orange-400 transition-colors"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-xs text-zinc-600 mt-1.5">
                  Include this exact memo so we can match your transfer to your account.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-amber-900/10 border border-amber-900/30 rounded-xl p-4">
            <div className="text-sm text-amber-400 font-medium mb-1">What happens next?</div>
            <ul className="text-sm text-zinc-400 space-y-1 list-disc list-inside">
              <li>Send the e-Transfer from your bank app</li>
              <li>We&apos;ll match it using the memo within 1 business day</li>
              <li>Your MJNx balance will be credited automatically</li>
            </ul>
          </div>

          <div className="flex flex-col gap-3">
            <Link
              href="/pay"
              className="block w-full text-center px-4 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-xl transition-colors"
            >
              Back to Dashboard
            </Link>
            <Link
              href="/pay/history"
              className="block w-full text-center px-4 py-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 font-medium rounded-xl transition-colors"
            >
              View Transaction History
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
