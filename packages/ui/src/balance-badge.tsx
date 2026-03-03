'use client';

import React, { useState, useEffect } from 'react';

export interface BalanceBadgeProps {
  /** DID of the user whose balance to show */
  did?: string | null;
  /** Pay service URL (e.g., https://pay.imajin.ai) */
  payUrl: string;
  /** Auth token for API requests */
  authToken?: string | null;
  /** Custom className for styling */
  className?: string;
}

interface BalanceData {
  did: string;
  amount: number;
  currency: string;
  updatedAt: string;
}

/**
 * Balance Badge Component
 *
 * Displays user's balance from the pay service.
 * - Only shows if user is logged in (has DID and token)
 * - Only shows if balance > 0
 * - Fetches balance from pay service
 */
export function BalanceBadge({ did, payUrl, authToken, className = '' }: BalanceBadgeProps) {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!did || !authToken) {
      setBalance(null);
      return;
    }

    let cancelled = false;

    async function fetchBalance() {
      setLoading(true);
      try {
        const res = await fetch(`${payUrl}/api/balance/${did}`, {
          headers: {
            'Authorization': `Bearer ${authToken}`,
          },
          credentials: 'include',
        });

        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setBalance(data);
          }
        } else {
          if (!cancelled) {
            setBalance(null);
          }
        }
      } catch (error) {
        console.error('Failed to fetch balance:', error);
        if (!cancelled) {
          setBalance(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchBalance();

    return () => {
      cancelled = true;
    };
  }, [did, authToken, payUrl]);

  // Don't show if not logged in
  if (!did || !authToken) {
    return null;
  }

  // Don't show while loading
  if (loading) {
    return null;
  }

  // Don't show if balance is 0 or null
  if (!balance || balance.amount <= 0) {
    return null;
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-orange-500/10 to-amber-500/10 border border-orange-500/20 ${className}`}
    >
      <span className="text-sm font-medium text-green-600 dark:text-green-400">
        ${balance.amount.toFixed(2)}
      </span>
    </div>
  );
}
