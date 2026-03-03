'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Tip {
  id: string;
  fromName?: string;
  amount: number;
  currency: string;
  message?: string;
  createdAt: string;
}

interface Stats {
  tips: Tip[];
  totals: {
    [currency: string]: {
      total: number;
      count: number;
    };
  };
}

export default function DashboardPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [userPage, setUserPage] = useState<any>(null);

  useEffect(() => {
    async function loadData() {
      try {
        // First, get user's page
        const pageRes = await fetch('/api/pages/mine', {
          credentials: 'include',
        });

        if (!pageRes.ok) {
          if (pageRes.status === 404) {
            setError('No coffee page found. Please create one first.');
          } else {
            setError('Failed to load dashboard');
          }
          setIsLoading(false);
          return;
        }

        const page = await pageRes.json();
        setUserPage(page);

        // Then get tips stats
        const tipsRes = await fetch(`/api/tips/${page.did}`, {
          credentials: 'include',
        });

        if (tipsRes.ok) {
          const tipsData = await tipsRes.json();
          setStats(tipsData);
        } else {
          setError('Failed to load tips data');
        }
      } catch (err) {
        console.error('Failed to load dashboard:', err);
        setError('Failed to load dashboard');
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, []);

  const formatAmount = (cents: number, currency: string) => {
    if (currency === 'USD') {
      return `$${(cents / 100).toFixed(2)}`;
    }
    return `${cents} ${currency}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return `${diffMins}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 30) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  const getThisMonthTotal = () => {
    if (!stats) return 0;

    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    return stats.tips
      .filter(tip => {
        const tipDate = new Date(tip.createdAt);
        return tipDate.getMonth() === thisMonth &&
               tipDate.getFullYear() === thisYear &&
               tip.currency === 'USD';
      })
      .reduce((sum, tip) => sum + tip.amount, 0);
  };

  const getSupporterCount = () => {
    if (!stats) return 0;
    const uniqueSupporters = new Set(
      stats.tips
        .filter(tip => tip.fromName)
        .map(tip => tip.fromName)
    );
    return uniqueSupporters.size;
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 dark:from-gray-900 dark:to-gray-800 py-8 px-4">
        <div className="max-w-5xl mx-auto text-center">
          <div className="text-4xl mb-4">☕</div>
          <p className="text-gray-600 dark:text-gray-400">Loading dashboard...</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 dark:from-gray-900 dark:to-gray-800 py-8 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-6 text-center">
            <p className="text-red-800 dark:text-red-200 mb-4">{error}</p>
            {error.includes('create one') && (
              <Link
                href="/edit"
                className="inline-block px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-semibold transition"
              >
                Create Coffee Page
              </Link>
            )}
          </div>
        </div>
      </main>
    );
  }

  const usdTotal = stats?.totals?.USD?.total || 0;
  const thisMonthTotal = getThisMonthTotal();
  const supporterCount = getSupporterCount();

  return (
    <main className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 dark:from-gray-900 dark:to-gray-800 py-8 px-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
            <p className="text-gray-600 dark:text-gray-400">
              Track your support and earnings
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href={`/${userPage?.handle}`}
              className="px-4 py-2 rounded-xl bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition font-medium"
            >
              View Page
            </Link>
            <Link
              href="/edit"
              className="px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 text-white transition font-medium"
            >
              Edit Page
            </Link>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {/* Total Earned */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">Total Earned</span>
              <span className="text-2xl">💰</span>
            </div>
            <div className="text-3xl font-bold text-orange-500">
              {formatAmount(usdTotal, 'USD')}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              All time
            </div>
          </div>

          {/* This Month */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">This Month</span>
              <span className="text-2xl">📈</span>
            </div>
            <div className="text-3xl font-bold text-orange-500">
              {formatAmount(thisMonthTotal, 'USD')}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </div>
          </div>

          {/* Supporters */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">Supporters</span>
              <span className="text-2xl">❤️</span>
            </div>
            <div className="text-3xl font-bold text-orange-500">
              {supporterCount}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Unique supporters
            </div>
          </div>
        </div>

        {/* Recent Tips */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6">
          <h2 className="text-xl font-bold mb-4">Recent Tips</h2>

          {stats && stats.tips.length > 0 ? (
            <div className="space-y-3">
              {stats.tips.map((tip) => (
                <div
                  key={tip.id}
                  className="flex items-start justify-between p-4 bg-gray-50 dark:bg-gray-700 rounded-xl"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold">
                        {tip.fromName || 'Anonymous'}
                      </span>
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {formatDate(tip.createdAt)}
                      </span>
                    </div>
                    {tip.message && (
                      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                        "{tip.message}"
                      </p>
                    )}
                  </div>
                  <div className="text-lg font-bold text-orange-500 ml-4">
                    {formatAmount(tip.amount, tip.currency)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <div className="text-4xl mb-3">☕</div>
              <p>No tips received yet</p>
              <p className="text-sm mt-2">Share your page to start receiving support!</p>
              {userPage && (
                <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg inline-block">
                  <code className="text-sm">
                    coffee.imajin.ai/{userPage.handle}
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
