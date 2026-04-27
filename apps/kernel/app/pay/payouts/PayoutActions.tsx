'use client';

import { useState } from 'react';
import { useToast } from '@imajin/ui';

interface PayoutActionsProps {
  status: 'not_connected' | 'incomplete_onboarding' | 'connected';
  did: string;
}

export function PayoutActions({ status, did }: PayoutActionsProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const handleOnboard = async () => {
    if (loading) return;

    setLoading(true);
    try {
      const currentUrl = window.location.href;

      const response = await fetch('/pay/api/connect/onboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          return_url: currentUrl,
          refresh_url: currentUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create onboarding link: ${response.status}`);
      }

      const data = await response.json();

      // Redirect to Stripe onboarding
      window.location.href = data.onboardingUrl;
    } catch (error) {
      console.error('Error starting onboarding:', error);
      toast.error('Failed to start onboarding process. Please try again.');
      setLoading(false);
    }
  };

  const handleDashboard = async () => {
    if (loading) return;

    setLoading(true);
    try {
      const response = await fetch(`/pay/api/connect/dashboard?did=${did}`, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`Failed to get dashboard link: ${response.status}`);
      }

      const data = await response.json();

      // Open Stripe dashboard in new tab
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Error opening dashboard:', error);
      toast.error('Failed to open dashboard. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (status === 'not_connected') {
    return (
      <button
        onClick={handleOnboard}
        disabled={loading}
        className="px-6 py-3 bg-imajin-orange hover:brightness-110 disabled:bg-imajin-orange/50 disabled:opacity-50 text-primary font-medium transition-colors"
      >
        {loading ? 'Setting up...' : 'Set up payouts'}
      </button>
    );
  }

  if (status === 'incomplete_onboarding') {
    return (
      <button
        onClick={handleOnboard}
        disabled={loading}
        className="px-6 py-3 bg-imajin-orange hover:brightness-110 disabled:bg-imajin-orange/50 disabled:opacity-50 text-primary font-medium transition-colors"
      >
        {loading ? 'Continuing setup...' : 'Continue setup'}
      </button>
    );
  }

  if (status === 'connected') {
    return (
      <button
        onClick={handleDashboard}
        disabled={loading}
        className="px-6 py-3 bg-imajin-orange hover:brightness-110 disabled:bg-imajin-orange/50 disabled:opacity-50 text-primary font-medium transition-colors"
      >
        {loading ? 'Opening dashboard...' : 'Manage payouts'}
      </button>
    );
  }

  return null;
}