'use client';

import { useState, useEffect, useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { apiFetch } from '@imajin/config';
import { Countdown } from './countdown';
import { useToast } from '@imajin/ui';

const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

interface CampaignStatus {
  targetAmount: number;
  currentAmount: number;
  pledgeCount: number;
  deadline: string | null;
  percentFunded: number;
  isFullyFunded: boolean;
}

interface Props {
  eventId: string;
  eventTitle: string;
  isAuthenticated: boolean;
}

const PRESET_AMOUNTS = [10, 25, 50, 100, 250];

export function CampaignSection({ eventId, eventTitle, isAuthenticated }: Readonly<Props>) {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pledging, setPledging] = useState(false);
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [userPledge, setUserPledge] = useState<{ id: string; amount: number; status: string } | null>(null);
  const { toast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/campaign/${eventId}/status`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch campaign status:', err);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  // Fetch user's pledge if authenticated
  const fetchUserPledge = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await apiFetch(`/api/campaign/${eventId}/my-pledge`);
      if (res.ok) {
        const data = await res.json();
        if (data.pledge) {
          setUserPledge(data.pledge);
        }
      }
    } catch {
      // Non-fatal — user may not have a pledge
    }
  }, [eventId, isAuthenticated]);

  useEffect(() => {
    fetchStatus();
    fetchUserPledge();
  }, [fetchStatus, fetchUserPledge]);

  async function handlePledge() {
    const amountCents = selectedAmount
      ? selectedAmount * 100
      : Math.round(Number.parseFloat(customAmount) * 100);

    if (!amountCents || amountCents < 100) {
      toast.error('Minimum pledge is $1.00');
      return;
    }

    if (!isAuthenticated) {
      toast.error('Please sign in to pledge');
      return;
    }

    setPledging(true);

    try {
      // Create pledge + SetupIntent
      const pledgeRes = await apiFetch('/api/campaign/pledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, amount: amountCents }),
      });

      if (!pledgeRes.ok) {
        const data = await pledgeRes.json().catch(() => ({}));
        toast.error(data.error || 'Failed to create pledge');
        setPledging(false);
        return;
      }

      const { pledgeId, clientSecret } = await pledgeRes.json();

      // Load Stripe and confirm SetupIntent
      if (!STRIPE_PUBLISHABLE_KEY) {
        toast.error('Stripe not configured');
        setPledging(false);
        return;
      }

      const stripe = await loadStripe(STRIPE_PUBLISHABLE_KEY);
      if (!stripe) {
        toast.error('Failed to load Stripe');
        setPledging(false);
        return;
      }

      const result = await stripe.confirmSetup({
        clientSecret,
        confirmParams: {
          return_url: `${globalThis.location.origin}/${eventId}?pledge=confirmed`,
        },
      });

      if ('error' in result && result.error) {
        toast.error(result.error.message || 'Payment setup failed');
        setPledging(false);
        return;
      }

      // Confirm pledge on server
      const setupIntent = 'setupIntent' in result ? (result as any).setupIntent : null;
      if (setupIntent?.status === 'succeeded') {
        const confirmRes = await apiFetch('/api/campaign/pledge/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pledgeId,
            setupIntentId: setupIntent.id as string,
            paymentMethodId: setupIntent.payment_method as string,
          }),
        });

        if (!confirmRes.ok) {
          const data = await confirmRes.json().catch(() => ({}));
          toast.error(data.error || 'Failed to confirm pledge');
          setPledging(false);
          return;
        }

        toast.success('Pledge confirmed! You will be charged when the goal is reached.');
        setUserPledge({ id: pledgeId, amount: amountCents, status: 'confirmed' });
        fetchStatus();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pledge failed');
    } finally {
      setPledging(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800/50 rounded-2xl shadow-lg p-6 md:p-8 mb-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/3" />
        </div>
      </div>
    );
  }

  if (!status) return null;

  const formattedTarget = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(status.targetAmount / 100);

  const formattedCurrent = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(status.currentAmount / 100);

  return (
    <div className="bg-white dark:bg-gray-800/50 rounded-2xl shadow-lg p-6 md:p-8 mb-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-2xl md:text-3xl font-bold">Campaign</h2>
        {status.isFullyFunded && (
          <span className="px-3 py-1 bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 text-sm font-semibold rounded-full">
            🎉 Goal Reached!
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-gray-500 dark:text-gray-400">
            {status.pledgeCount} backer{status.pledgeCount === 1  ? '' : 's'}
          </span>
          <span className="font-semibold">
            {formattedCurrent} of {formattedTarget}
          </span>
        </div>
        <div className="w-full h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-500"
            style={{ width: `${status.percentFunded}%` }}
          />
        </div>
        <div className="text-right text-sm text-gray-500 dark:text-gray-400 mt-1">
          {status.percentFunded}% funded
        </div>
      </div>

      {/* Deadline countdown */}
      {status.deadline && !status.isFullyFunded && (
        <div className="mb-6">
          <Countdown targetDate={status.deadline} label="Campaign ends in" />
        </div>
      )}

      {/* User's pledge */}
      {userPledge && (
        <div className="mb-6 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl">
          <p className="text-sm text-green-800 dark:text-green-300">
            ✅ Your pledge:{' '}
            <strong>
              {new Intl.NumberFormat('en-CA', {
                style: 'currency',
                currency: 'CAD',
              }).format(userPledge.amount / 100)}
            </strong>{' '}
            — will be charged when the goal is reached
          </p>
        </div>
      )}

      {/* Pledge form */}
      {!userPledge && !status.isFullyFunded && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Select an amount to pledge. You won&apos;t be charged until the campaign reaches its goal.
          </p>

          {/* Preset amounts */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {PRESET_AMOUNTS.map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => {
                  setSelectedAmount(amt);
                  setCustomAmount('');
                }}
                className={`py-2.5 rounded-lg font-semibold text-sm transition ${
                  selectedAmount === amt
                    ? 'bg-orange-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                ${amt}
              </button>
            ))}
          </div>

          {/* Custom amount */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 dark:text-gray-400">$</span>
            <input
              type="number"
              min="1"
              step="0.01"
              placeholder="Custom amount"
              value={customAmount}
              onChange={(e) => {
                setCustomAmount(e.target.value);
                setSelectedAmount(null);
              }}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
            />
          </div>

          {/* Pledge button */}
          <button
            onClick={handlePledge}
            disabled={pledging || (!selectedAmount && !customAmount)}
            className="w-full py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-semibold rounded-lg transition"
          >
            {(() => {
              if (pledging) return 'Processing...';
              if (selectedAmount || customAmount) return `Pledge $${selectedAmount || customAmount}`;
              return 'Back this Campaign';
            })()}
          </button>

          {!isAuthenticated && (
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              Sign in to pledge
            </p>
          )}
        </div>
      )}

      {status.isFullyFunded && !userPledge && (
        <div className="text-center py-4">
          <p className="text-lg font-semibold text-green-600 dark:text-green-400">
            🎉 This campaign has reached its goal!
          </p>
        </div>
      )}
    </div>
  );
}
