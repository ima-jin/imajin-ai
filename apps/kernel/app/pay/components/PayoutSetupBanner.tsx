'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface ConnectStatus {
  did: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  onboardingComplete: boolean;
  defaultCurrency: string;
}

interface PayoutSetupBannerProps {
  message?: string;
  did: string;
}

export function PayoutSetupBanner({
  message = "Set up payouts to receive funds",
  did
}: PayoutSetupBannerProps) {
  const [shouldShow, setShouldShow] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkConnectStatus = async () => {
      try {
        // Check if banner was previously dismissed (stored in localStorage)
        const dismissedKey = `payout-banner-dismissed-${did}`;
        if (localStorage.getItem(dismissedKey) === 'true') {
          setIsDismissed(true);
          setLoading(false);
          return;
        }

        const response = await fetch(`/pay/api/connect/status?did=${did}`, {
          headers: {
            'Cache-Control': 'no-cache',
          },
        });

        if (response.status === 404) {
          // Not connected - show banner
          setShouldShow(true);
        } else if (response.ok) {
          const status: ConnectStatus = await response.json();
          // Show banner if onboarding is not complete
          setShouldShow(!status.onboardingComplete);
        }
        // If there's an error or other status, don't show banner
      } catch (error) {
        console.error('Error checking connect status for banner:', error);
        // On error, don't show banner to avoid annoying users
      } finally {
        setLoading(false);
      }
    };

    if (did) {
      checkConnectStatus();
    } else {
      setLoading(false);
    }
  }, [did]);

  const handleDismiss = () => {
    const dismissedKey = `payout-banner-dismissed-${did}`;
    localStorage.setItem(dismissedKey, 'true');
    setIsDismissed(true);
  };

  // Don't render anything while loading, if dismissed, or if shouldn't show
  if (loading || isDismissed || !shouldShow) {
    return null;
  }

  return (
    <div className="bg-imajin-orange/10 border border-imajin-orange/30 p-4 mb-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 bg-imajin-orange rounded-full animate-pulse shrink-0"></div>
          <div className="flex-1">
            <p className="text-sm text-imajin-orange/70">
              {message}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Link
            href="/pay/payouts"
            className="text-sm text-imajin-orange hover:text-imajin-orange/70 font-medium transition-colors"
          >
            Set up payouts →
          </Link>
          <button
            onClick={handleDismiss}
            className="text-imajin-orange/60 hover:text-imajin-orange text-lg leading-none transition-colors"
            aria-label="Dismiss banner"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}