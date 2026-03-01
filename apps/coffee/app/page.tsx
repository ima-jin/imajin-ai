'use client';

import { useState } from 'react';

const PRESETS = [
  { amount: 500, label: '$5' },
  { amount: 1000, label: '$10' },
  { amount: 2000, label: '$20' },
  { amount: 3500, label: '$35' },
  { amount: 7500, label: '$75' },
  { amount: 20000, label: '$200' },
];

export default function CoffeePage() {
  const [selectedAmount, setSelectedAmount] = useState(1000);
  const [customAmount, setCustomAmount] = useState('');
  const [isRecurring, setIsRecurring] = useState(false);
  const [joinMailingList, setJoinMailingList] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const getAmount = () => {
    if (customAmount) {
      return Math.round(parseFloat(customAmount) * 100);
    }
    return selectedAmount;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const amount = getAmount();
    if (amount < 500) {
      setError('Minimum is $5');
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          amount,
          recurring: isRecurring,
          joinMailingList,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create checkout');
      }

      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  const formatAmount = (cents: number) => {
    return `$${(cents / 100).toFixed(0)}`;
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 dark:from-gray-900 dark:to-gray-800 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <img 
            src="/images/logo-kanji.svg" 
            alt="今人" 
            className="w-24 h-24 mx-auto mb-4"
          />
          <img 
            src="/images/logo.svg" 
            alt="Imajin" 
            className="h-10 mx-auto mb-4"
          />
          <p className="text-gray-500">Sovereign infrastructure. Built in public. Funded by you.</p>
        </div>

        {/* The Thought */}
        <div className="bg-orange-100 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold mb-3 text-orange-800 dark:text-orange-200">A thought on where your money goes</h2>
          <div className="text-orange-900 dark:text-orange-100 space-y-3">
            <p>
              You probably spend $20/month on subscriptions you barely touch — feeding platforms 
              that turn your attention into their product.
            </p>
            <p>
              What if that money went to open source projects building the alternative? Infrastructure 
              owned by people, not shareholders. Tools that undo the mess instead of profiting from it.
            </p>
            <p className="font-semibold">This is that.</p>
          </div>
        </div>

        {/* The Story */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Why I Need Your Help</h2>
          
          <div className="prose dark:prose-invert prose-sm max-w-none text-gray-600 dark:text-gray-300 space-y-4">
            <p>
              Hello, my name is <strong>Ryan VETEZE</strong> and I am building{' '}
              <a href="https://imajin.ai" className="text-orange-500 hover:underline">imajin.ai</a>.
            </p>
            
            <p>
              I am actively working to get us out of this mess. And it's <em>not</em> easy. 
              There is so much to think about. And contrary to what you may have heard, these AI tools 
              still need an incredible amount of direction if you want to have happy outcomes.
            </p>
            
            <p>
              I have been unemployed since May — thankfully! Because that move allowed me to pivot 
              fully into the emerging AI generative coding tools that were already excellent then. 
              If I had stayed employed in my corporate job, I would have been completely floundering 
              in this moment.
            </p>
            
            <p>
              But cash is now starting to get scarce. I'm currently spending about <strong>$45 USD per day</strong> on 
              AI inference costs alone — and that's expected to rise as the scope of this project increases.
            </p>
            
            <p>
              Think of this as my Patreon page. Or my Twitch subscriber page. We will come up with 
              ways in the coming weeks and months to recognize our biggest supporters.
            </p>
            
            <p className="font-medium text-gray-800 dark:text-gray-100">
              Please support me if you can. If you have the capacity. Every bit helps.
            </p>
            
            <p>
              This gives me the freedom to support <em>you</em> without having to resort to work 
              for a company that wants to extract <em>from</em> you. Inversing this paradigm will 
              take brains. And I still need to pay my mortgage.
            </p>
          </div>
        </div>

        {/* Support Form */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            
            {/* One-time vs Monthly Toggle */}
            <div className="flex justify-center">
              <div className="inline-flex bg-gray-100 dark:bg-gray-700 rounded-xl p-1">
                <button
                  type="button"
                  onClick={() => setIsRecurring(false)}
                  className={`px-6 py-2 rounded-lg font-medium transition ${
                    !isRecurring
                      ? 'bg-white dark:bg-gray-600 shadow text-gray-900 dark:text-white'
                      : 'text-gray-500'
                  }`}
                >
                  One-time
                </button>
                <button
                  type="button"
                  onClick={() => setIsRecurring(true)}
                  className={`px-6 py-2 rounded-lg font-medium transition ${
                    isRecurring
                      ? 'bg-white dark:bg-gray-600 shadow text-gray-900 dark:text-white'
                      : 'text-gray-500'
                  }`}
                >
                  Monthly
                </button>
              </div>
            </div>

            {/* Amount Presets */}
            <div className="grid grid-cols-3 gap-3">
              {PRESETS.map((preset) => (
                <button
                  key={preset.amount}
                  type="button"
                  onClick={() => {
                    setSelectedAmount(preset.amount);
                    setCustomAmount('');
                  }}
                  className={`p-4 rounded-xl font-semibold transition-all ${
                    selectedAmount === preset.amount && !customAmount
                      ? 'bg-orange-500 text-white shadow-lg scale-105'
                      : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {preset.label}
                  {isRecurring && <span className="text-xs block opacity-75">/month</span>}
                </button>
              ))}
            </div>

            {/* Custom Amount */}
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-medium">$</span>
              <input
                type="number"
                step="1"
                min="5"
                placeholder="Custom amount"
                value={customAmount}
                onChange={(e) => {
                  setCustomAmount(e.target.value);
                  setSelectedAmount(0);
                }}
                className="w-full pl-8 pr-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white dark:bg-gray-700"
              />
              {isRecurring && customAmount && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">/month</span>
              )}
            </div>

            {/* Mailing List Checkbox */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={joinMailingList}
                onChange={(e) => setJoinMailingList(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
              />
              <span className="text-gray-600 dark:text-gray-300">
                Subscribe to updates about Imajin
              </span>
            </label>

            {/* Error */}
            {error && (
              <p className="text-red-500 text-sm text-center">{error}</p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading || getAmount() < 500}
              className="w-full py-4 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-semibold text-lg transition-all hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading 
                ? 'Redirecting to checkout...' 
                : isRecurring 
                  ? `Support with ${formatAmount(getAmount())}/month`
                  : `Support with ${formatAmount(getAmount())}`
              }
            </button>

            <p className="text-center text-xs text-gray-400">
              Secure payment via Stripe. {isRecurring ? 'Cancel anytime.' : 'One-time payment.'}
            </p>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-gray-500 mt-8">
          <a href="https://imajin.ai" className="text-orange-500 hover:underline">imajin.ai</a>
          {' · '}
          <a href="https://discord.gg/6hkQW3uw4m" className="hover:underline">Discord</a>
          {' · '}
          <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline">GitHub</a>
        </p>
      </div>
    </main>
  );
}
