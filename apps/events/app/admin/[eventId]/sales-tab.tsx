'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@imajin/ui';
import { apiFetch } from '@imajin/config';

interface BuyerProfile {
  name: string | null;
  handle: string | null;
  avatar: string | null;
}

interface TicketInOrder {
  ticketId: string;
  status: string;
}

interface Sale {
  orderId: string;
  buyerDid: string | null;
  buyerName: string | null;
  buyerHandle: string | null;
  buyerAvatar: string | null;
  ticketType: string;
  quantity: number;
  amountTotal: number;
  currency: string;
  paymentMethod: string | null;
  stripeSessionId: string | null;
  paymentId: string | null;
  purchasedAt: string | null;
  tickets: TicketInOrder[];
  status: string;
}

interface OrphanTicket {
  ticketId: string;
  status: string;
  ownerDid: string | null;
  pricePaid: number | null;
  currency: string | null;
  purchasedAt: string | null;
  ticketType: string;
  paymentMethod: string | null;
  paymentId: string | null;
}

interface OrphanOrder {
  orderId: string;
  buyerDid: string | null;
  amountTotal: number;
  currency: string;
  purchasedAt: string | null;
  ticketType: string;
  quantity: number;
  paymentMethod: string | null;
  stripeSessionId: string | null;
}

interface SalesData {
  sales: Sale[];
  orphans: OrphanTicket[];
  orphanOrders: OrphanOrder[];
  summary: {
    totalSales: number;
    totalRevenue: number;
    avgOrderValue: number;
    totalOrders: number;
  };
}

interface SalesTabProps {
  eventId: string;
}

function formatCurrency(cents: number | null, currency: string | null): string {
  if (cents === null || cents === undefined) return '—';
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: currency || 'CAD',
  }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncateId(id: string, length = 12): string {
  if (!id) return '—';
  if (id.length <= length + 3) return id;
  return `${id.slice(0, length)}…`;
}

function getStripeDashboardUrl(paymentId: string | null, sessionId: string | null): string | null {
  if (paymentId?.startsWith('pi_')) {
    return `https://dashboard.stripe.com/payments/${paymentId}`;
  }
  if (sessionId?.startsWith('cs_')) {
    return `https://dashboard.stripe.com/payments/${sessionId}`;
  }
  return null;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">
          completed
        </span>
      );
    case 'pending':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
          pending
        </span>
      );
    case 'partial':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
          partial
        </span>
      );
    case 'refunded':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
          refunded
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
          cancelled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
          {status}
        </span>
      );
  }
}

function ProfileCell({ buyerDid, buyerName, buyerHandle, buyerAvatar }: {
  buyerDid: string | null;
  buyerName: string | null;
  buyerHandle: string | null;
  buyerAvatar: string | null;
}) {
  const display = buyerName || buyerHandle || (buyerDid ? truncateId(buyerDid, 20) : '—');
  const initials = display.charAt(0).toUpperCase();
  const profileUrl = buyerHandle
    ? `/profile/${encodeURIComponent(buyerHandle)}`
    : buyerDid
    ? `/profile/${encodeURIComponent(buyerDid)}`
    : null;

  const nameContent = buyerName && (
    <p className="text-sm font-medium truncate">{buyerName}</p>
  );
  const handleContent = buyerHandle && (
    <p className="text-xs text-gray-400 truncate">@{buyerHandle}</p>
  );
  const didContent = !buyerName && !buyerHandle && buyerDid && (
    <p className="text-xs text-gray-400 font-mono truncate">{truncateId(buyerDid, 20)}</p>
  );
  const emptyContent = !buyerName && !buyerHandle && !buyerDid && (
    <p className="text-xs text-gray-400">—</p>
  );

  return (
    <div className="flex items-center gap-2 min-w-0">
      {buyerAvatar ? (
        <img
          src={buyerAvatar}
          alt={display}
          className="w-8 h-8 rounded-full object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0 text-xs font-semibold text-white">
          {initials}
        </div>
      )}
      <div className="min-w-0">
        {profileUrl ? (
          <a href={profileUrl} className="hover:text-orange-500 transition">
            {nameContent}
            {handleContent}
            {didContent}
          </a>
        ) : (
          <>
            {nameContent}
            {handleContent}
            {didContent}
          </>
        )}
        {emptyContent}
      </div>
    </div>
  );
}

export function SalesTab({ eventId }: SalesTabProps) {
  const { toast } = useToast();
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch(`/api/events/${eventId}/sales`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: SalesData) => {
        setData(data);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load sales data');
        setLoading(false);
      });
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExport = async (format: 'csv' | 'xlsx' = 'csv') => {
    setExporting(true);
    try {
      const res = await apiFetch(`/api/events/${eventId}/sales/export?format=${format}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('content-disposition');
      const match = disposition?.match(/filename="([^"]+)"/);
      a.download = match?.[1] || `sales.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Export downloaded');
    } catch {
      toast.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <p className="text-gray-500 text-sm">Loading sales data…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <p className="text-red-500 text-sm">{error}</p>
        <button
          onClick={load}
          className="mt-2 px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data || data.sales.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Sales</h2>
        </div>
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400 text-lg font-medium">No sales yet</p>
          <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">
            Ticket purchases will appear here once attendees start buying.
          </p>
        </div>
      </div>
    );
  }

  const { sales, orphans, orphanOrders, summary } = data;
  const totalOrphans = orphans.length + orphanOrders.length;

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <StatCard label="Total Orders" value={summary.totalOrders} />
        <StatCard label="Completed Sales" value={summary.totalSales} />
        <StatCard label="Total Revenue" value={formatCurrency(summary.totalRevenue, 'CAD')} />
        <StatCard label="Avg. Order Value" value={formatCurrency(summary.avgOrderValue, 'CAD')} />
      </div>

      {/* Orphan warning */}
      {totalOrphans > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <span className="text-amber-600 dark:text-amber-400 text-lg">⚠️</span>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {totalOrphans} transaction{totalOrphans !== 1 ? 's' : ''} need attention
            </p>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            Some tickets or orders have mismatched data and may need manual review.
          </p>
        </div>
      )}

      {/* Export button */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Transactions</h2>
        <button
          onClick={() => handleExport('csv')}
          disabled={exporting}
          className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition border border-gray-200 dark:border-gray-600 disabled:opacity-50"
        >
          {exporting ? 'Exporting…' : '⬇ Export Sales'}
        </button>
      </div>

      {/* Sales table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Buyer
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Tickets
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Amount
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Stripe Ref
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sales.map((sale) => {
                const stripeUrl = getStripeDashboardUrl(sale.paymentId, sale.stripeSessionId);
                const isOrphanOrder = orphanOrders.some(o => o.orderId === sale.orderId);

                return (
                  <tr
                    key={sale.orderId}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                      isOrphanOrder ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <ProfileCell
                        buyerDid={sale.buyerDid}
                        buyerName={sale.buyerName}
                        buyerHandle={sale.buyerHandle}
                        buyerAvatar={sale.buyerAvatar}
                      />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {sale.quantity}x {sale.ticketType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {formatCurrency(sale.amountTotal, sale.currency)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <StatusBadge status={sale.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {formatDateTime(sale.purchasedAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {stripeUrl ? (
                        <a
                          href={stripeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-400 hover:text-gray-300 transition font-mono"
                          title={sale.stripeSessionId || sale.paymentId || ''}
                        >
                          {truncateId(sale.stripeSessionId || sale.paymentId || '—', 16)}
                        </a>
                      ) : (
                        <span className="text-xs text-gray-400 font-mono">
                          {truncateId(sale.stripeSessionId || sale.paymentId || '—', 16)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Orphan tickets section */}
      {orphans.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3 text-amber-700 dark:text-amber-400">
            Orphan Tickets ({orphans.length})
          </h3>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden border border-amber-200 dark:border-amber-800">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead className="bg-amber-50 dark:bg-amber-900/20">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Ticket ID
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Price
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Payment
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {orphans.map((orphan) => (
                    <tr key={orphan.ticketId} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 bg-amber-50/30 dark:bg-amber-900/10">
                      <td className="px-4 py-3 text-xs font-mono text-gray-500 dark:text-gray-400">
                        {orphan.ticketId}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {orphan.ticketType}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge status={orphan.status === 'valid' || orphan.status === 'used' ? 'completed' : orphan.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatCurrency(orphan.pricePaid, orphan.currency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatDateTime(orphan.purchasedAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {orphan.paymentMethod || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Orphan orders section */}
      {orphanOrders.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3 text-amber-700 dark:text-amber-400">
            Orphan Orders ({orphanOrders.length})
          </h3>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden border border-amber-200 dark:border-amber-800">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead className="bg-amber-50 dark:bg-amber-900/20">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Order ID
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Quantity
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      Stripe Ref
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {orphanOrders.map((order) => (
                    <tr key={order.orderId} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 bg-amber-50/30 dark:bg-amber-900/10">
                      <td className="px-4 py-3 text-xs font-mono text-gray-500 dark:text-gray-400">
                        {order.orderId}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {order.ticketType}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {order.quantity}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatCurrency(order.amountTotal, order.currency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatDateTime(order.purchasedAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400 font-mono whitespace-nowrap">
                        {truncateId(order.stripeSessionId || '—', 16)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-3 md:p-4 shadow">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
