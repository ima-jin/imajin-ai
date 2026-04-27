'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@imajin/ui';
import { buildPublicUrl } from '@imajin/config';
import { apiFetch } from '@imajin/config';

interface LinkStats {
  id: string;
  title: string;
  url: string;
  clicks: number;
}

interface DayStats {
  date: string;
  clicks: number;
}

interface ReferrerStats {
  referrer: string;
  clicks: number;
}

interface Stats {
  totalClicks: number;
  clicksByLink: LinkStats[];
  clicksByDay: DayStats[];
  topReferrers: ReferrerStats[];
}

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [handle, setHandle] = useState<string>('');

  useEffect(() => {
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchStats = async () => {
    try {
      // First get the user's page
      const pageRes = await apiFetch('/api/pages/mine', {
        credentials: 'include',
      });

      if (pageRes.ok) {
        const page = await pageRes.json();
        if (!page.id) {
          router.push('/edit');
          return;
        }

        setHandle(page.handle);

        // Then fetch stats
        const statsRes = await apiFetch(`/api/pages/${page.handle}/stats`, {
          credentials: 'include',
        });

        if (statsRes.ok) {
          const data = await statsRes.json();
          setStats(data);
        }
      } else if (pageRes.status === 401) {
        const AUTH_URL = buildPublicUrl('auth');
        window.location.href = `${AUTH_URL}/login?next=${encodeURIComponent(window.location.href)}`;
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-elevated dark:bg-surface-surface">
        <div className="text-xl">Loading stats...</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="min-h-screen py-12 px-4 bg-surface-elevated dark:bg-surface-surface">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-2xl font-bold mb-4">No stats available</h1>
          <p className="text-muted dark:text-secondary mb-6">
            Unable to load stats. Please try again.
          </p>
          <button
            onClick={() => router.push('/edit')}
            className="px-6 py-3 bg-imajin-orange text-primary font-semibold hover:brightness-110 transition"
          >
            Go to Editor
          </button>
        </div>
      </div>
    );
  }

  const maxClicks = Math.max(...stats.clicksByLink.map(l => l.clicks), 1);
  const maxDayClicks = Math.max(...stats.clicksByDay.map(d => d.clicks), 1);

  return (
    <div className="min-h-screen py-12 px-4 bg-surface-elevated dark:bg-surface-surface">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">My Links Page</h1>
            <p className="text-muted dark:text-secondary">
              <a
                href={`/${handle}`}
                target="_blank"
                className="text-imajin-orange:underline"
              >
                links.imajin.ai/{handle}
              </a>
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}/${handle}`);
                toast.success('Link copied!');
              }}
              className="px-4 py-2 border border-white/10 dark:border-white/10 text-sm font-medium:bg-surface-elevated dark:hover:bg-surface-elevated transition"
            >
              📋 Copy Link
            </button>
            <button
              onClick={() => router.push('/edit')}
              className="px-4 py-2 border border-white/10 dark:border-white/10 text-sm font-medium:bg-surface-elevated dark:hover:bg-surface-elevated transition"
            >
              ✏️ Edit Page
            </button>
            <a
              href={`/${handle}`}
              target="_blank"
              className="px-4 py-2 bg-imajin-orange text-primary text-sm font-medium hover:brightness-110 transition"
            >
              👁️ View Page
            </a>
          </div>
        </div>

        {/* Total Clicks Card */}
        <div className="mb-8 p-6 bg-gradient-to-br from-imajin-purple to-imajin-blue text-primary">
          <div className="text-sm font-medium opacity-90 mb-2">Total Clicks</div>
          <div className="text-5xl font-bold">{stats.totalClicks.toLocaleString()}</div>
          <div className="text-sm opacity-75 mt-2">All time</div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Clicks by Link */}
          <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-6">
            <h2 className="text-xl font-bold mb-4">Clicks by Link</h2>
            {stats.clicksByLink.length === 0 ? (
              <p className="text-secondary text-center py-8">No clicks yet</p>
            ) : (
              <div className="space-y-3">
                {stats.clicksByLink.map((link) => (
                  <div key={link.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium truncate">{link.title}</span>
                      <span className="text-muted dark:text-secondary ml-2">
                        {link.clicks}
                      </span>
                    </div>
                    <div className="w-full bg-surface-elevated dark:bg-surface-elevated rounded-full h-2">
                      <div
                        className="bg-imajin-orange h-2 rounded-full transition-all"
                        style={{ width: `${(link.clicks / maxClicks) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top Referrers */}
          <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-6">
            <h2 className="text-xl font-bold mb-4">Top Referrers</h2>
            {stats.topReferrers.length === 0 ? (
              <p className="text-secondary text-center py-8">No referrer data yet</p>
            ) : (
              <div className="space-y-3">
                {stats.topReferrers.map((ref, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate">
                      {ref.referrer || 'Direct'}
                    </span>
                    <span className="text-sm text-muted dark:text-secondary ml-2">
                      {ref.clicks}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Clicks Over Time */}
        <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-6">
          <h2 className="text-xl font-bold mb-4">Clicks Over Last 30 Days</h2>
          {stats.clicksByDay.length === 0 ? (
            <p className="text-secondary text-center py-8">No click data yet</p>
          ) : (
            <div className="space-y-2">
              {stats.clicksByDay.map((day) => (
                <div key={day.date} className="flex items-center gap-3">
                  <div className="w-24 text-sm text-muted dark:text-secondary">
                    {new Date(day.date).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 bg-surface-elevated dark:bg-surface-elevated rounded-full h-6">
                      <div
                        className="bg-imajin-orange h-6 rounded-full flex items-center justify-end pr-2 text-primary text-xs font-medium transition-all"
                        style={{
                          width: `${Math.max((day.clicks / maxDayClicks) * 100, 5)}%`,
                        }}
                      >
                        {day.clicks > 0 && day.clicks}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
