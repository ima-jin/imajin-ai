'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import PriceDisplay from '../components/PriceDisplay';
import { resolveMediaRef } from '@imajin/media';

interface Listing {
  id: string;
  title: string;
  price: number;
  currency: string;
  category: string | null;
  images: string[] | null;
  status: string;
  sellerTier: string;
  createdAt: string;
}

interface ListingsResponse {
  listings: Listing[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

type StatusFilter = 'all' | 'active' | 'paused' | 'sold' | 'rented' | 'unavailable' | 'removed';

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'sold', label: 'Sold' },
  { value: 'rented', label: 'Rented' },
  { value: 'unavailable', label: 'Unavailable' },
  { value: 'removed', label: 'Removed' },
];

const LIMIT = 20;

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-900/50 text-green-400 border-green-700/50',
    paused: 'bg-yellow-900/50 text-yellow-400 border-yellow-700/50',
    sold: 'bg-blue-900/50 text-blue-400 border-blue-700/50',
    rented: 'bg-purple-900/50 text-purple-400 border-purple-700/50',
    unavailable: 'bg-gray-700 text-gray-300 border-gray-600',
    removed: 'bg-gray-800 text-gray-400 border-gray-700',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
        styles[status] ?? 'bg-gray-800 text-gray-400 border-gray-700'
      }`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-400 uppercase tracking-wide">{label}</span>
      <span className="text-3xl font-bold text-white">{value}</span>
    </div>
  );
}

export default function DashboardPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    type: 'sold' | 'remove';
    id: string;
    title: string;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Stats computed from all listings (fetched separately)
  const [allListings, setAllListings] = useState<Listing[]>([]);
  const [statsLoaded, setStatsLoaded] = useState(false);

  const authUrl = `${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}auth.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}`;

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/my/listings?limit=100', { credentials: 'include' });
      if (!res.ok) return;
      const data: ListingsResponse = await res.json();
      setAllListings(data.listings);
      setStatsLoaded(true);
    } catch {
      // stats are best-effort
    }
  }, []);

  const fetchListings = useCallback(async (currentPage: number, status: StatusFilter) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(currentPage), limit: String(LIMIT) });
      if (status !== 'all') params.set('status', status);

      const res = await fetch(`/api/my/listings?${params.toString()}`, { credentials: 'include' });

      if (res.status === 401) {
        window.location.href = `${authUrl}/login?next=${encodeURIComponent(window.location.href)}`;
        return;
      }

      if (!res.ok) throw new Error('Failed to load listings');
      const data: ListingsResponse = await res.json();
      setListings(data.listings);
      setTotal(data.total);
    } catch {
      setError('Could not load your listings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [authUrl]);

  useEffect(() => {
    fetchListings(page, statusFilter);
  }, [fetchListings, page, statusFilter]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  function handleTabChange(tab: StatusFilter) {
    setStatusFilter(tab);
    setPage(1);
  }

  async function patchStatus(id: string, status: string) {
    setPendingAction(id);
    setActionError('');
    // Optimistic update
    setListings((prev) =>
      prev.map((l) => (l.id === id ? { ...l, status } : l))
    );
    try {
      const res = await fetch(`/api/listings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update listing');
      }
      // Refresh stats
      fetchStats();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
      // Revert optimistic update
      fetchListings(page, statusFilter);
    } finally {
      setPendingAction(null);
    }
  }

  async function removeListing(id: string) {
    setPendingAction(id);
    setActionError('');
    setConfirmAction(null);
    // Optimistic: mark as removed
    setListings((prev) =>
      prev.map((l) => (l.id === id ? { ...l, status: 'removed' } : l))
    );
    try {
      const res = await fetch(`/api/listings/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove listing');
      }
      fetchStats();
      // If filtering by non-removed status, remove from list
      if (statusFilter !== 'all' && statusFilter !== 'removed') {
        setListings((prev) => prev.filter((l) => l.id !== id));
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Remove failed');
      fetchListings(page, statusFilter);
    } finally {
      setPendingAction(null);
    }
  }

  const stats = {
    active: allListings.filter((l) => l.status === 'active').length,
    paused: allListings.filter((l) => l.status === 'paused').length,
    sold: allListings.filter((l) => l.status === 'sold').length,
    rented: allListings.filter((l) => l.status === 'rented').length,
    unavailable: allListings.filter((l) => l.status === 'unavailable').length,
    total: allListings.length,
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">My Listings</h1>
            <p className="text-gray-400 text-sm mt-0.5">Manage your marketplace listings</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-medium rounded-xl transition text-sm border border-gray-700"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
            <Link
              href="/listings/new"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition text-sm shadow-lg shadow-orange-500/20"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New Listing
            </Link>
          </div>
        </div>

        {/* Stats Bar */}
        {statsLoaded && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
            <StatCard label="Active" value={stats.active} />
            <StatCard label="Paused" value={stats.paused} />
            <StatCard label="Sold" value={stats.sold} />
            <StatCard label="Rented" value={stats.rented} />
            <StatCard label="Unavailable" value={stats.unavailable} />
            <StatCard label="Total" value={stats.total} />
          </div>
        )}
        {!statsLoaded && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="bg-gray-800 rounded-xl p-4 animate-pulse">
                <div className="h-3 bg-gray-700 rounded w-1/2 mb-2" />
                <div className="h-8 bg-gray-700 rounded w-1/3" />
              </div>
            ))}
          </div>
        )}

        {/* Stripe Connect banner */}
        <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-400">
          <svg className="w-4 h-4 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" />
          </svg>
          <span className="flex-1">Connect Stripe to accept card payments for protected listings</span>
          <button
            disabled
            className="px-3 py-1 rounded-lg bg-gray-700 text-gray-500 text-xs font-medium cursor-not-allowed"
          >
            Connect Stripe
          </button>
        </div>

        {/* Action error */}
        {actionError && (
          <div className="mb-4 px-4 py-3 bg-red-900/30 border border-red-800 rounded-xl text-sm text-red-400 flex items-center justify-between gap-2">
            <span>{actionError}</span>
            <button onClick={() => setActionError('')} className="text-red-500 hover:text-red-300 transition">×</button>
          </div>
        )}

        {/* Status Filter Tabs */}
        <div className="flex gap-1 border-b border-gray-800 mb-6 overflow-x-auto">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition border-b-2 -mb-px ${
                statusFilter === tab.value
                  ? 'border-orange-500 text-orange-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Listings */}
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse flex gap-4">
                <div className="w-16 h-16 bg-gray-800 rounded-lg shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-800 rounded w-1/2" />
                  <div className="h-3 bg-gray-800 rounded w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={() => fetchListings(page, statusFilter)}
              className="px-4 py-2 bg-orange-500 text-white rounded-xl hover:bg-orange-600 transition text-sm font-medium"
            >
              Retry
            </button>
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">🏪</div>
            <p className="text-lg font-medium text-gray-200 mb-2">
              {statusFilter === 'all'
                ? "You haven't listed anything yet."
                : `No ${statusFilter} listings.`}
            </p>
            {statusFilter === 'all' && (
              <Link
                href="/listings/new"
                className="inline-block mt-4 px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition"
              >
                Create Your First Listing
              </Link>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-800/50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide w-14">Image</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Title</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Price</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Category</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Created</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {listings.map((listing) => (
                    <ListingRow
                      key={listing.id}
                      listing={listing}
                      pending={pendingAction === listing.id}
                      onPause={() => patchStatus(listing.id, 'paused')}
                      onResume={() => patchStatus(listing.id, 'active')}
                      onMarkSold={() =>
                        setConfirmAction({ type: 'sold', id: listing.id, title: listing.title })
                      }
                      onMarkUnavailable={() => patchStatus(listing.id, 'unavailable')}
                      onRemove={() =>
                        setConfirmAction({ type: 'remove', id: listing.id, title: listing.title })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {listings.map((listing) => (
                <MobileListingCard
                  key={listing.id}
                  listing={listing}
                  pending={pendingAction === listing.id}
                  onPause={() => patchStatus(listing.id, 'paused')}
                  onResume={() => patchStatus(listing.id, 'active')}
                  onMarkSold={() =>
                    setConfirmAction({ type: 'sold', id: listing.id, title: listing.title })
                  }
                  onMarkUnavailable={() => patchStatus(listing.id, 'unavailable')}
                  onRemove={() =>
                    setConfirmAction({ type: 'remove', id: listing.id, title: listing.title })
                  }
                />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-8">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="px-4 py-2 rounded-lg bg-gray-900 border border-gray-800 text-sm font-medium disabled:opacity-40 hover:border-orange-500 hover:text-orange-500 transition"
                >
                  ← Previous
                </button>
                <div className="flex gap-1">
                  {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                    const p = i + 1;
                    return (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={`w-9 h-9 rounded-lg text-sm font-medium transition ${
                          p === page
                            ? 'bg-orange-500 text-white'
                            : 'bg-gray-900 border border-gray-800 hover:border-orange-500 hover:text-orange-500'
                        }`}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-4 py-2 rounded-lg bg-gray-900 border border-gray-800 text-sm font-medium disabled:opacity-40 hover:border-orange-500 hover:text-orange-500 transition"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirmation modal */}
      {confirmAction && (
        <ConfirmModal
          action={confirmAction}
          onConfirm={() => {
            if (confirmAction.type === 'sold') {
              patchStatus(confirmAction.id, 'sold');
              setConfirmAction(null);
            } else {
              removeListing(confirmAction.id);
            }
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Floating new listing button (mobile) */}
      <div className="fixed bottom-6 right-6 md:hidden z-10">
        <Link
          href="/listings/new"
          className="flex items-center gap-2 px-4 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-full shadow-xl shadow-orange-500/30 transition"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Listing
        </Link>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface ListingActionProps {
  listing: Listing;
  pending: boolean;
  onPause: () => void;
  onResume: () => void;
  onMarkSold: () => void;
  onMarkUnavailable: () => void;
  onRemove: () => void;
}

function ListingThumbnail({ images }: { images: string[] | null }) {
  const imgs = Array.isArray(images) ? images : [];
  const ref = imgs.find((img) => typeof img === 'string' && img.length > 0);
  const src = ref ? resolveMediaRef(ref, 'thumbnail') : undefined;
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" className="w-12 h-12 object-cover rounded-lg" />
    );
  }
  return (
    <div className="w-12 h-12 bg-gray-800 rounded-lg flex items-center justify-center text-gray-600">
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    </div>
  );
}

function ActionButtons({ listing, pending, onPause, onResume, onMarkSold, onMarkUnavailable, onRemove }: ListingActionProps) {
  const isActive = listing.status === 'active';
  const isPaused = listing.status === 'paused';
  const canToggle = isActive || isPaused;
  const canSell = isActive;
  const canMarkUnavailable = isActive;
  const canRemove = isActive || isPaused;

  return (
    <div className="flex items-center gap-1 flex-wrap justify-end">
      <Link
        href={`/listings/${listing.id}/edit`}
        className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-700 transition"
      >
        Edit
      </Link>

      {canToggle && (
        <button
          disabled={pending}
          onClick={isPaused ? onResume : onPause}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-700 transition disabled:opacity-40"
        >
          {isPaused ? 'Resume' : 'Pause'}
        </button>
      )}

      {canSell && (
        <button
          disabled={pending}
          onClick={onMarkSold}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 transition disabled:opacity-40"
        >
          Mark Sold
        </button>
      )}

      {canMarkUnavailable && (
        <button
          disabled={pending}
          onClick={onMarkUnavailable}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition disabled:opacity-40"
        >
          Unavailable
        </button>
      )}

      {canRemove && (
        <button
          disabled={pending}
          onClick={onRemove}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-900/30 transition disabled:opacity-40"
        >
          Remove
        </button>
      )}

      <Link
        href="/listings/new"
        className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition"
      >
        Duplicate
      </Link>
    </div>
  );
}

function ListingRow(props: ListingActionProps) {
  const { listing } = props;
  return (
    <tr className="hover:bg-gray-800/30 transition-colors">
      <td className="px-4 py-3">
        <ListingThumbnail images={listing.images} />
      </td>
      <td className="px-4 py-3">
        <Link
          href={`/listings/${listing.id}`}
          className="font-medium text-gray-100 hover:text-orange-400 transition line-clamp-2 max-w-xs"
        >
          {listing.title}
        </Link>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <PriceDisplay
          price={listing.price}
          currency={listing.currency}
          className="text-amber-400 font-semibold"
        />
      </td>
      <td className="px-4 py-3">
        {listing.category ? (
          <span className="px-2 py-0.5 text-xs bg-gray-800 text-gray-400 rounded-full border border-gray-700">
            {listing.category}
          </span>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={listing.status} />
      </td>
      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
        {relativeTime(listing.createdAt)}
      </td>
      <td className="px-4 py-3">
        <ActionButtons {...props} />
      </td>
    </tr>
  );
}

function MobileListingCard(props: ListingActionProps) {
  const { listing } = props;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex gap-3 mb-3">
        <ListingThumbnail images={listing.images} />
        <div className="flex-1 min-w-0">
          <Link
            href={`/listings/${listing.id}`}
            className="font-medium text-gray-100 hover:text-orange-400 transition line-clamp-2 text-sm"
          >
            {listing.title}
          </Link>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <PriceDisplay
              price={listing.price}
              currency={listing.currency}
              className="text-amber-400 font-semibold text-sm"
            />
            <StatusBadge status={listing.status} />
          </div>
          {listing.category && (
            <span className="inline-block mt-1 px-2 py-0.5 text-xs bg-gray-800 text-gray-400 rounded-full border border-gray-700">
              {listing.category}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{relativeTime(listing.createdAt)}</span>
        <ActionButtons {...props} />
      </div>
    </div>
  );
}

function ConfirmModal({
  action,
  onConfirm,
  onCancel,
}: {
  action: { type: 'sold' | 'remove'; id: string; title: string };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isSold = action.type === 'sold';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
        <h3 className="text-lg font-semibold text-white mb-2">
          {isSold ? 'Mark as Sold?' : 'Remove Listing?'}
        </h3>
        <p className="text-sm text-gray-400 mb-6">
          {isSold
            ? `Mark "${action.title}" as sold? Buyers will no longer see it as available.`
            : `Are you sure you want to remove "${action.title}"? This can't be undone.`}
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-white text-sm font-medium transition ${
              isSold
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {isSold ? 'Mark as Sold' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
