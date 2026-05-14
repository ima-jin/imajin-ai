'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@imajin/config';
import { useToast } from '@imajin/ui';

interface Pledge {
  id: string;
  backerDid: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  chargedAt: string | null;
  failureReason: string | null;
}

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
}

export function CampaignDashboard({ eventId }: Props) {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [pledges, setPledges] = useState<Pledge[]>([]);
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [settleResult, setSettleResult] = useState<any>(null);
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, pledgesRes] = await Promise.all([
        apiFetch(`/api/campaign/${eventId}/status`),
        apiFetch(`/api/campaign/${eventId}/pledges`),
      ]);

      if (statusRes.ok) {
        const s = await statusRes.json();
        setStatus(s);
      }

      if (pledgesRes.ok) {
        const p = await pledgesRes.json();
        setPledges(p.pledges || []);
      }
    } catch (err) {
      console.error('Failed to fetch campaign data:', err);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleSettle() {
    if (!status?.isFullyFunded) {
      toast.error('Campaign target has not been met');
      return;
    }

    if (!confirm('This will charge all confirmed backers. Continue?')) {
      return;
    }

    setSettling(true);
    setSettleResult(null);

    try {
      const res = await apiFetch(`/api/campaign/${eventId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error || 'Settlement failed');
        setSettling(false);
        return;
      }

      setSettleResult(data);
      toast.success(`Charged ${data.charged} of ${data.total} pledges`);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Settlement failed');
    } finally {
      setSettling(false);
    }
  }

  async function handleCancel() {
    if (!confirm('This will cancel the campaign and all pledges. This cannot be undone. Continue?')) {
      return;
    }

    setCancelling(true);

    try {
      const res = await apiFetch(`/api/campaign/${eventId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error || 'Cancel failed');
        setCancelling(false);
        return;
      }

      toast.success(`Cancelled ${data.cancelled} pledges`);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancelling(false);
    }
  }

  const currencyFmt = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  });

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
        <div className="animate-pulse h-32 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Campaign Status</h2>
        {status && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-gray-400">Goal</div>
              <div className="text-xl font-bold">{currencyFmt.format(status.targetAmount / 100)}</div>
            </div>
            <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-gray-400">Raised</div>
              <div className="text-xl font-bold text-green-600">{currencyFmt.format(status.currentAmount / 100)}</div>
            </div>
            <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-gray-400">Backers</div>
              <div className="text-xl font-bold">{status.pledgeCount}</div>
            </div>
            <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-gray-400">Progress</div>
              <div className="text-xl font-bold">{status.percentFunded}%</div>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {status && (
          <div className="mt-4">
            <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${status.percentFunded}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={handleSettle}
          disabled={settling || !status?.isFullyFunded}
          className={`px-6 py-3 rounded-lg font-semibold transition ${
            status?.isFullyFunded
              ? 'bg-green-500 hover:bg-green-600 text-white'
              : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
          }`}
        >
          {settling ? 'Charging...' : '💰 Charge All Backers'}
        </button>
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="px-6 py-3 rounded-lg font-semibold bg-red-500 hover:bg-red-600 disabled:bg-red-300 text-white transition"
        >
          {cancelling ? 'Cancelling...' : '🚫 Cancel Campaign'}
        </button>
      </div>

      {!status?.isFullyFunded && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Charging is only available when the campaign reaches its funding goal.
        </p>
      )}

      {/* Settlement results */}
      {settleResult && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <h3 className="text-lg font-semibold mb-3">Settlement Results</h3>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
              <div className="text-2xl font-bold text-green-600">{settleResult.charged}</div>
              <div className="text-xs text-gray-500">Charged</div>
            </div>
            <div className="text-center p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <div className="text-2xl font-bold text-red-600">{settleResult.failed}</div>
              <div className="text-xs text-gray-500">Failed</div>
            </div>
            <div className="text-center p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div className="text-2xl font-bold">{settleResult.total}</div>
              <div className="text-xs text-gray-500">Total</div>
            </div>
          </div>
          {settleResult.results?.length > 0 && (
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {settleResult.results.map((r: any) => (
                <div
                  key={r.pledgeId}
                  className={`flex items-center justify-between px-3 py-2 rounded text-sm ${
                    r.status === 'charged'
                      ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                      : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                  }`}
                >
                  <span className="font-mono text-xs">{r.pledgeId.slice(0, 16)}...</span>
                  <span className="text-xs">{r.status === 'charged' ? '✅ Charged' : `❌ ${r.error || 'Failed'}`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pledges table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Pledges ({pledges.length})</h3>
        {pledges.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">No pledges yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Backer</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Amount</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Date</th>
                </tr>
              </thead>
              <tbody>
                {pledges.map((p) => (
                  <tr key={p.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 px-3 font-mono text-xs">{p.backerDid.slice(0, 16)}...</td>
                    <td className="py-2 px-3 text-right font-semibold">
                      {currencyFmt.format(p.amount / 100)}
                    </td>
                    <td className="py-2 px-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="py-2 px-3 text-gray-500 dark:text-gray-400">
                      {new Date(p.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300',
    confirmed: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    charged: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    failed: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    cancelled: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
  };

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}
