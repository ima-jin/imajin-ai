'use client';

import { useState, useEffect } from 'react';

interface PayoutSetupBannerProps {
  did: string;
  payUrl: string;
  message?: string;
}

/**
 * Reusable banner nudging users to connect their bank for payouts.
 * Works cross-service — pass the pay service URL explicitly.
 *
 * Checks GET {payUrl}/api/connect/status?did=xxx
 * If not connected or incomplete → shows dismissible banner linking to {payUrl}/payouts
 * If connected or on error → renders nothing
 */
export function PayoutSetupBanner({
  did,
  payUrl,
  message = 'Set up payouts to receive funds from events, tips, and sales',
}: PayoutSetupBannerProps) {
  const [shouldShow, setShouldShow] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const dismissedKey = `payout-banner-dismissed-${did}`;
    if (typeof window !== 'undefined' && localStorage.getItem(dismissedKey) === 'true') {
      setLoading(false);
      return;
    }

    const check = async () => {
      try {
        const res = await fetch(`${payUrl}/api/connect/status?did=${encodeURIComponent(did)}`, {
          credentials: 'include',
        });

        if (res.status === 404 || res.status === 403) {
          setShouldShow(true);
        } else if (res.ok) {
          const data = await res.json();
          setShouldShow(!data.onboardingComplete);
        }
      } catch {
        // Network error / endpoint doesn't exist yet — stay hidden
      } finally {
        setLoading(false);
      }
    };

    if (did) check();
    else setLoading(false);
  }, [did, payUrl]);

  const handleDismiss = () => {
    localStorage.setItem(`payout-banner-dismissed-${did}`, 'true');
    setShouldShow(false);
  };

  if (loading || !shouldShow) return null;

  return (
    <div className="bg-orange-900/20 border border-orange-800/50 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse shrink-0" />
          <p className="text-sm text-orange-200">{message}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <a
            href={`${payUrl}/payouts`}
            className="text-sm text-orange-400 hover:text-orange-300 font-medium transition-colors whitespace-nowrap"
          >
            Set up payouts →
          </a>
          <button
            onClick={handleDismiss}
            className="text-orange-400/60 hover:text-orange-400 text-lg leading-none transition-colors"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
