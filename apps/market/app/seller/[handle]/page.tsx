'use client';

import { Suspense, useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { ImajinFooter } from '@imajin/ui';
import ListingCard from '../../components/ListingCard';

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

function SellerPageContent() {
  const params = useParams();
  const handle = decodeURIComponent(params.handle as string);

  const [listings, setListings] = useState<Listing[]>([]);
  const [sellerName, setSellerName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        // Server-side handle resolution + listings in one call
        const res = await fetch(
          `/api/seller/handle/${encodeURIComponent(handle)}`
        );
        if (!res.ok) {
          setError('Seller not found.');
          setLoading(false);
          return;
        }
        const data = await res.json();
        setSellerName(`@${data.seller?.handle ?? handle}`);
        setListings(data.listings ?? []);
      } catch {
        setError('Could not load seller listings. Please try again.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [handle]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              <a href="/" className="hover:text-orange-500 transition">Market</a>
              {' / '}
              <span>Seller</span>
            </p>
            <h1 className="text-3xl font-bold">
              {sellerName ?? `@${handle}`}
            </h1>
            {!loading && !error && (
              <p className="text-gray-500 dark:text-gray-400 mt-1">
                {listings.length} active listing{listings.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <a
            href="/"
            className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition font-medium whitespace-nowrap text-sm"
          >
            ← Browse All
          </a>
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
            <a href="/" className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition">
              Back to Market
            </a>
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-16 text-gray-500 dark:text-gray-400">
            <div className="text-5xl mb-4">📭</div>
            <p className="text-lg font-medium mb-2">No active listings</p>
            <p className="text-sm">This seller has no active listings right now.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {listings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        )}

      </div>

      <ImajinFooter className="mt-12" />
    </div>
  );
}

export default function SellerPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <SellerPageContent />
    </Suspense>
  );
}
