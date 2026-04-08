'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ImajinFooter } from '@imajin/ui';
import { apiFetch } from '@imajin/config';
import ListingCard from './components/ListingCard';

interface Listing {
  id: string;
  title: string;
  price: number;
  currency: string;
  category: string | null;
  images: string[];
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

const LIMIT = 12;
const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'JPY', 'KRW'];
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price_asc', label: 'Price: Low → High' },
  { value: 'price_desc', label: 'Price: High → Low' },
];

function MarketPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = searchParams.get('q') || '';
  const category = searchParams.get('category') || '';
  const currency = searchParams.get('currency') || '';
  const sort = searchParams.get('sort') || 'newest';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));

  const totalPages = Math.ceil(total / LIMIT);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: 'active',
        page: String(page),
        limit: String(LIMIT),
        sort,
      });
      if (query) params.set('q', query);
      if (category) params.set('category', category);
      if (currency) params.set('currency', currency);

      const res = await apiFetch(`/api/listings?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load listings');
      const data: ListingsResponse = await res.json();
      setListings(data.listings);
      setTotal(data.total);
    } catch {
      setError('Could not load listings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [page, sort, query, category, currency]);

  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  function updateParams(updates: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in updates)) next.delete('page');
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">Browse Listings</h1>
            <p className="text-gray-500 dark:text-gray-400">
              Local commerce with trust.{total > 0 && ` ${total} listing${total !== 1 ? 's' : ''} available.`}
            </p>
          </div>
          <Link
            href="/dashboard"
            className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium whitespace-nowrap"
          >
            My Listings
          </Link>
        </div>

        {/* Search + Filters */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 mb-6 space-y-3">
          <input
            type="search"
            placeholder="Search listings..."
            defaultValue={query}
            onKeyDown={(e) => {
              if (e.key === 'Enter') updateParams({ q: (e.target as HTMLInputElement).value });
            }}
            onBlur={(e) => {
              if (e.target.value !== query) updateParams({ q: e.target.value });
            }}
            className="w-full px-4 py-2.5 rounded-lg bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-orange-500 focus:outline-none focus:bg-white dark:focus:bg-gray-700 transition"
          />

          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              placeholder="Category..."
              defaultValue={category}
              onKeyDown={(e) => {
                if (e.key === 'Enter') updateParams({ category: (e.target as HTMLInputElement).value });
              }}
              onBlur={(e) => {
                if (e.target.value !== category) updateParams({ category: e.target.value });
              }}
              className="flex-1 min-w-[140px] px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-orange-500 focus:outline-none focus:bg-white dark:focus:bg-gray-700 transition text-sm"
            />

            <select
              value={currency}
              onChange={(e) => updateParams({ currency: e.target.value })}
              className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-orange-500 focus:outline-none transition text-sm"
            >
              <option value="">All currencies</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <select
              value={sort}
              onChange={(e) => updateParams({ sort: e.target.value })}
              className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-orange-500 focus:outline-none transition text-sm"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Results */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-pulse">
                <div className="aspect-video bg-gray-200 dark:bg-gray-800" />
                <div className="p-4 space-y-2">
                  <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-3/4" />
                  <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-red-500 mb-4">{error}</p>
            <button
              onClick={fetchListings}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition"
            >
              Retry
            </button>
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-16 text-gray-500 dark:text-gray-400">
            <div className="text-5xl mb-4">🏪</div>
            <p className="text-lg font-medium mb-2">No listings found</p>
            <p className="text-sm">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {listings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-8">
            <button
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) })}
              className="px-4 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-sm font-medium disabled:opacity-40 hover:border-orange-500 hover:text-orange-500 transition"
            >
              ← Previous
            </button>

            <div className="flex gap-1">
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const p = i + 1;
                return (
                  <button
                    key={p}
                    onClick={() => updateParams({ page: String(p) })}
                    className={`w-9 h-9 rounded-lg text-sm font-medium transition ${
                      p === page
                        ? 'bg-orange-500 text-white'
                        : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 hover:border-orange-500 hover:text-orange-500'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>

            <button
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) })}
              className="px-4 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-sm font-medium disabled:opacity-40 hover:border-orange-500 hover:text-orange-500 transition"
            >
              Next →
            </button>
          </div>
        )}

      </div>

      <ImajinFooter className="mt-12" />
    </div>
  );
}

export default function MarketPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <MarketPageContent />
    </Suspense>
  );
}
